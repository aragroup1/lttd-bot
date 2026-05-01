import { Bot } from "grammy";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config, TEMPLATES, rsvpSign } from "./config.js";
import { classifyIntent, slugify } from "./intent.js";
import { runAgent } from "./agent.js";
import { listClients, readClientSite, deleteClientFolder } from "./tools/github.js";
import { appendRsvpRow, deleteRsvpSheet } from "./tools/google.js";
import { attachDomain, deleteVercelProject } from "./tools/vercel.js";

const bot = new Bot(config.telegramBotToken);
const ownerIds = new Set(config.telegramOwnerIds);

const HELP_TEXT =
  `LinkToTheDay bot — commands:\n\n` +
  `New client, <template>\n` +
  `<details (couple, date, venue, sections to add/remove)>\n` +
  `[Slug: <override>]\n\n` +
  `On <slug>, <what to change>\n\n` +
  `Domain <slug> <yourdomain.com>\n` +
  `Delete <slug>!\n` +
  `List my clients\n` +
  `Show <slug>\n` +
  `Help\n\n` +
  `Templates: ${TEMPLATES.join(", ")}.`;

bot.on("message", async (ctx) => {
  const fromId = ctx.from?.id;
  if (!fromId || !ownerIds.has(fromId)) {
    console.log(`[reject] fromId=${fromId} text=${ctx.message.text?.slice(0, 80)}`);
    return;
  }

  const text = ctx.message.text?.trim();
  if (!text) return;

  console.log(`[msg] fromId=${fromId} text=${text.slice(0, 120)}`);

  try {
    const intent = await classifyIntent(text);

    if (intent.kind === "help") {
      await ctx.reply(HELP_TEXT);
      return;
    }

    if (intent.kind === "list") {
      const clients = await listClients();
      if (!clients.length) return void (await ctx.reply("No clients yet."));
      await ctx.reply(clients.map((c) => `${c.color}/${c.slug}`).join("\n"));
      return;
    }

    if (intent.kind === "show") {
      const clients = await listClients();
      const match = clients.find((c) => c.slug === intent.slug);
      if (!match) return void (await ctx.reply(`No client with slug "${intent.slug}".`));
      const html = await readClientSite(match.color, match.slug);
      await ctx.reply(
        `${match.color}/${match.slug} — https://${match.slug}.vercel.app\n\n(HTML length: ${html.length} chars)`
      );
      return;
    }

    if (intent.kind === "delete") {
      const clients = await listClients();
      const match = clients.find((c) => c.slug === intent.slug);
      if (!match) return void (await ctx.reply(`No client with slug "${intent.slug}".`));
      await ctx.reply(`Deleting ${match.color}/${match.slug}…`);
      const repo = await deleteClientFolder(match.color, match.slug, `${match.color}/${match.slug}: delete`);
      const vercel = await deleteVercelProject(match.slug);
      const sheet = await deleteRsvpSheet(match.color, match.slug);
      await ctx.reply(
        `Deleted ${match.color}/${match.slug}.\n` +
          `• GitHub files removed: ${repo.deleted}\n` +
          `• Vercel project: ${vercel.deleted ? "deleted" : "not found"}\n` +
          `• RSVP sheet: ${sheet.deleted ? "deleted" : "not found"}`
      );
      return;
    }

    if (intent.kind === "domain") {
      await ctx.reply(`Attaching ${intent.domain} to ${intent.slug}…`);
      const res = await attachDomain(intent.slug, intent.domain);
      const dnsLines = res.dnsHints.map((l) => `  ${l}`).join("\n");
      await ctx.reply(
        `Domain ${res.domain} attached to ${intent.slug}.\n` +
          (res.verified ? `Verified.` : `Not yet verified — set DNS:\n${dnsLines}\nThen Vercel will verify automatically (can take a few minutes).`)
      );
      return;
    }

    if (intent.kind === "unknown") {
      await ctx.reply(`I couldn't parse that.\n\n${HELP_TEXT}\n\nReason: ${intent.reason}`);
      return;
    }

    let header: string;
    let agentPrompt: string;
    if (intent.kind === "new") {
      const slugOverride = intent.rawDetails.match(/^slug:\s*([a-z0-9-]+)\s*$/im)?.[1];
      const suggestedSlug =
        slugOverride ?? slugify(intent.rawDetails.match(/couple[:\s]+([^\n]+)/i)?.[1] ?? "");
      header = `Creating ${intent.template}/${suggestedSlug || "<derived-slug>"}…`;
      agentPrompt =
        `Intent: NEW client.\n` +
        `Template: ${intent.template}\n` +
        (slugOverride
          ? `Required slug (use exactly): ${slugOverride}\n`
          : suggestedSlug
          ? `Suggested slug: ${suggestedSlug}\n`
          : "") +
        `\nClient details:\n${intent.rawDetails}`;
    } else {
      header = `Editing ${intent.slug}…`;
      agentPrompt =
        `Intent: EDIT existing client.\n` +
        `Slug: ${intent.slug}\n` +
        `(Figure out the template color by trying readClientSite on each template until one succeeds.)\n\n` +
        `Requested changes:\n${intent.rawDetails}`;
    }

    const status = await ctx.reply(header);
    const statusMsgId = status.message_id;
    const chatId = ctx.chat.id;
    const updates: string[] = [header];

    const onProgress = (label: string) => {
      updates.push(`• ${label}`);
      ctx.api
        .editMessageText(chatId, statusMsgId, updates.join("\n"))
        .catch((e) => console.warn("[edit-status]", e?.message));
    };

    const result = await runAgent(agentPrompt, onProgress);

    const lines: string[] = [];
    if (result.facts.liveUrl) lines.push(`Live: ${result.facts.liveUrl}`);
    if (result.facts.sheetUrl) lines.push(`RSVP sheet: ${result.facts.sheetUrl}`);
    if (result.facts.slug) lines.push(`Slug: ${result.facts.slug}`);
    if (result.text) lines.push("", result.text);

    await ctx.reply(lines.join("\n").slice(0, 4000));
  } catch (err: any) {
    console.error("[error]", err);
    await ctx.reply(`Error: ${err?.message ?? String(err)}`.slice(0, 4000));
  }
});

bot.catch((err) => {
  console.error("[bot.catch]", err);
});

const app = express();
app.use(cors({ origin: true, credentials: false, methods: ["POST", "OPTIONS"] }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));

const rsvpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.get("/", (_req, res) => res.status(200).send("lttd-bot ok"));

app.post("/rsvp", rsvpLimiter, async (req, res) => {
  const body = req.body ?? {};
  const sheetId = typeof body.sheetId === "string" ? body.sheetId : "";
  const slug = typeof body.slug === "string" ? body.slug : "";
  const sig = typeof body.sig === "string" ? body.sig : "";

  if (!sheetId || !slug || !sig) {
    res.status(400).json({ error: "missing sheetId/slug/sig" });
    return;
  }
  if (rsvpSign(slug, sheetId) !== sig) {
    console.warn(`[rsvp-rejected] bad sig slug=${slug} sheetId=${sheetId.slice(0, 8)}…`);
    res.status(403).json({ error: "bad signature" });
    return;
  }

  try {
    await appendRsvpRow(sheetId, body);
    console.log(`[rsvp] slug=${slug} sheetId=${sheetId.slice(0, 8)}…`);

    const summary =
      `RSVP for ${slug}:\n` +
      ["name", "attending", "guests", "dietary", "message"]
        .filter((k) => body[k])
        .map((k) => `• ${k}: ${String(body[k]).slice(0, 200)}`)
        .join("\n");
    for (const ownerId of config.telegramOwnerIds) {
      bot.api.sendMessage(ownerId, summary).catch((e) => console.warn("[notify-fail]", e?.message));
    }

    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[rsvp-error]", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.listen(config.port, () => {
  console.log(`[boot] http server on :${config.port} (public=${config.publicUrl})`);
});

console.log(
  `[boot] LinkToTheDay bot starting. owners=${config.telegramOwnerIds.join(",")} repo=${config.githubRepo}`
);

bot.start({
  onStart: (info) => console.log(`[boot] @${info.username} polling`),
});
