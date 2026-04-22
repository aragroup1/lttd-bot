import { Bot } from "grammy";
import { config, TEMPLATES } from "./config.js";
import { classifyIntent, slugify } from "./intent.js";
import { runAgent } from "./agent.js";
import { listClients, readClientSite } from "./tools/github.js";

const bot = new Bot(config.telegramBotToken);

const ownerIds = new Set(config.telegramOwnerIds);

bot.on("message", async (ctx) => {
  const fromId = ctx.from?.id;
  const chatId = ctx.chat.id;

  if (!fromId || !ownerIds.has(fromId)) {
    console.log(`[reject] fromId=${fromId} chatId=${chatId} text=${ctx.message.text?.slice(0, 80)}`);
    return;
  }

  const text = ctx.message.text?.trim();
  if (!text) return;

  console.log(`[msg] fromId=${fromId} text=${text.slice(0, 120)}`);

  try {
    const intent = await classifyIntent(text);

    if (intent.kind === "list") {
      const clients = await listClients();
      if (!clients.length) {
        await ctx.reply("No clients yet.");
        return;
      }
      await ctx.reply(clients.map((c) => `${c.color}/${c.slug}`).join("\n"));
      return;
    }

    if (intent.kind === "show") {
      const clients = await listClients();
      const match = clients.find((c) => c.slug === intent.slug);
      if (!match) {
        await ctx.reply(`No client with slug "${intent.slug}".`);
        return;
      }
      const html = await readClientSite(match.color, match.slug);
      await ctx.reply(
        `${match.color}/${match.slug} — https://lttd-${match.color}-${match.slug}.vercel.app\n\n(HTML length: ${html.length} chars)`
      );
      return;
    }

    if (intent.kind === "unknown") {
      await ctx.reply(
        `I couldn't parse that. Use:\n` +
          `  New client, <template>\\n<details>\n` +
          `  On <slug>, <changes>\n` +
          `  List my clients\n` +
          `  Show <slug>\n\n` +
          `Templates: ${TEMPLATES.join(", ")}.\n\nReason: ${intent.reason}`
      );
      return;
    }

    await ctx.reply("Working on it…");

    let agentPrompt: string;
    if (intent.kind === "new") {
      const suggestedSlug = slugify(intent.rawDetails.match(/couple[:\s]+([^\n]+)/i)?.[1] ?? "");
      agentPrompt =
        `Intent: NEW client.\n` +
        `Template: ${intent.template}\n` +
        (suggestedSlug ? `Suggested slug: ${suggestedSlug}\n` : "") +
        `\nClient details:\n${intent.rawDetails}`;
    } else {
      agentPrompt =
        `Intent: EDIT existing client.\n` +
        `Slug: ${intent.slug}\n` +
        `(Figure out the template color by checking which <template>/<slug>/index.html exists. If unclear, try each template via readClientSite until one succeeds.)\n\n` +
        `Requested changes:\n${intent.rawDetails}`;
    }

    const reply = await runAgent(agentPrompt);
    await ctx.reply(reply.slice(0, 4000));
  } catch (err: any) {
    console.error("[error]", err);
    await ctx.reply(`Error: ${err?.message ?? String(err)}`.slice(0, 4000));
  }
});

bot.catch((err) => {
  console.error("[bot.catch]", err);
});

console.log(
  `[boot] LinkToTheDay bot starting. owners=${config.telegramOwnerIds.join(",")} repo=${config.githubRepo}`
);

bot.start({
  onStart: (info) => console.log(`[boot] @${info.username} polling`),
});
