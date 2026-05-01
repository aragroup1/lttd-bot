import Anthropic from "@anthropic-ai/sdk";
import { config, TEMPLATES } from "./config.js";
import { readTemplate, readClientSite, createFromTemplate, editClientSite } from "./tools/github.js";
import { ensureVercelProject, deploySite, attachDomain } from "./tools/vercel.js";
import { ensureRsvpSheet } from "./tools/google.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are the LinkToTheDay site builder. You edit wedding microsites stored at <template>/<slug>/index.html in the GitHub repo.

Templates available: ${TEMPLATES.join(", ")}.

Folder convention: <template>/<slug>/index.html. Slugs are lowercase, hyphenated, derived from the couple's first names only (strip surnames, & and "and"). Examples: "Sarah Ahmed & Tom Wright" -> "sarah-tom". "Arman & Faiza" -> "arman-faiza". If the user provides a "Required slug" in the prompt, use it verbatim without modification.

Do NOT ask the user to confirm the slug. Proceed using the suggested/required slug directly. The only time to stop and reply with a question is when a tool returns SLUG_TAKEN — in that case, reply with the exact instruction from the tool error (telling the user to resend with a "Slug: <alternative>" line).

Rules:
- For NEW clients, call tools in this order:
  1. ensureVercelProject(color, suggested_slug) — the returned 'slug' may be auto-suffixed if the original was taken (e.g. "arman-faiza" -> "arman-faiza-2"). USE THIS RETURNED SLUG for every subsequent call. If the response is SLUG_TAKEN, stop and reply with the instruction.
  2. ensureRsvpSheet(color, finalSlug) — returns {sheetId, sheetUrl, sig}.
  3. readTemplate(color) — see the template HTML.
  4. createFromTemplate(color, finalSlug, edits, commitMessage) — small {find, replace} edits that substitute names/dates/venue AND wire up RSVP (see below).
  5. deploySite(color, finalSlug) — direct upload (no Git link).
- For EDITS: (1) readClientSite(color, slug). (2) editClientSite(color, slug, edits, commitMessage). (3) deploySite(color, slug). Do not rewrite unrelated sections. If the template color is unknown, try readClientSite on each template until one succeeds.

Preserve template structure, styling, scripts. Only change copy/dates and add/remove sections the user asked for. DO NOT add or remove form fields — keep the template's inputs as-is.

Edit rules (important):
- Each {find, replace} must contain enough surrounding context that 'find' matches EXACTLY ONCE in the source. If 'find' isn't unique, include more context (parent tag, adjacent text).
- 'find' must match byte-for-byte (whitespace, case). Copy verbatim from the readTemplate/readClientSite output.
- Prefer many small edits over one big edit.

RSVP wiring (NEW clients only — skip for edits unless explicitly asked):
- Use edits inside createFromTemplate to patch the existing <form>:
  - Change its opening tag to: <form method="POST" action="${config.publicUrl}/rsvp">
  - Insert three hidden inputs immediately after the opening <form ...> tag:
      <input type="hidden" name="sheetId" value="<sheetId-from-ensureRsvpSheet>">
      <input type="hidden" name="slug" value="<slug>">
      <input type="hidden" name="sig" value="<sig-from-ensureRsvpSheet>">
  - Just before </form>, append this script so the page doesn't navigate away:
      <script>document.querySelector('form').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.target);await fetch(e.target.action,{method:'POST',body:new URLSearchParams(f)});e.target.innerHTML='<p>Thanks — your RSVP was recorded.</p>';});</script>
- If the template has NO <form>, skip RSVP wiring silently.

Final reply: one short message with the live URL (https://<finalSlug>.vercel.app), the final slug, the RSVP sheet URL (if created), and a one-line changelog.
Commit messages: concise (<72 chars), e.g. "como/sarah-tom: initial site" or "como/sarah-tom: update date to 22 Aug".`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "readTemplate",
    description: "Read the base HTML template for a given color (como, orange, pink, purple, red, white). Returns full index.html source.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" } },
      required: ["color"],
    },
  },
  {
    name: "readClientSite",
    description: "Read an existing client's index.html at <color>/<slug>/index.html. Throws if not found.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" }, slug: { type: "string" } },
      required: ["color", "slug"],
    },
  },
  {
    name: "createFromTemplate",
    description:
      "Create a new client site at <color>/<slug>/index.html by reading the base template and applying small {find, replace} edits. Each 'find' must match EXACTLY ONCE in the template source — include enough surrounding context to make it unique. Returns {commitSha, path, editsApplied}.",
    input_schema: {
      type: "object",
      properties: {
        color: { type: "string" },
        slug: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string" },
              replace: { type: "string" },
            },
            required: ["find", "replace"],
          },
        },
        commitMessage: { type: "string" },
      },
      required: ["color", "slug", "edits", "commitMessage"],
    },
  },
  {
    name: "editClientSite",
    description:
      "Edit an existing client site at <color>/<slug>/index.html by applying {find, replace} edits. Same uniqueness rules as createFromTemplate. Returns {commitSha, path, editsApplied}.",
    input_schema: {
      type: "object",
      properties: {
        color: { type: "string" },
        slug: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string" },
              replace: { type: "string" },
            },
            required: ["find", "replace"],
          },
        },
        commitMessage: { type: "string" },
      },
      required: ["color", "slug", "edits", "commitMessage"],
    },
  },
  {
    name: "ensureVercelProject",
    description: "Idempotent: find or create a Vercel project named <slug> (no Git connection). Returns {projectId, name, productionUrl}.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" }, slug: { type: "string" } },
      required: ["color", "slug"],
    },
  },
  {
    name: "ensureRsvpSheet",
    description: "Create (or find) the Google Sheet for this client's RSVP responses. Returns {sheetId, sheetUrl, name, sig}. 'sig' must be embedded as a hidden form input named 'sig' so the /rsvp endpoint can verify the post.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" }, slug: { type: "string" } },
      required: ["color", "slug"],
    },
  },
  {
    name: "attachDomain",
    description: "Attach a custom domain (e.g. armanandfaiza.com) to a client's Vercel project. Returns DNS records the user must set. Only call this when the user explicitly issues a 'Domain' command.",
    input_schema: {
      type: "object",
      properties: { slug: { type: "string" }, domain: { type: "string" } },
      required: ["slug", "domain"],
    },
  },
  {
    name: "deploySite",
    description:
      "Read the current <color>/<slug>/index.html from GitHub and upload it directly to the Vercel project as a production deployment. Waits until READY. Returns {deploymentUrl, state, name}.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" }, slug: { type: "string" } },
      required: ["color", "slug"],
    },
  },
];

async function dispatchTool(name: string, input: any): Promise<string> {
  try {
    switch (name) {
      case "readTemplate":
        return await readTemplate(input.color);
      case "readClientSite":
        return await readClientSite(input.color, input.slug);
      case "createFromTemplate":
        return JSON.stringify(
          await createFromTemplate(input.color, input.slug, input.edits, input.commitMessage)
        );
      case "editClientSite":
        return JSON.stringify(
          await editClientSite(input.color, input.slug, input.edits, input.commitMessage)
        );
      case "ensureVercelProject":
        return JSON.stringify(await ensureVercelProject(input.color, input.slug));
      case "ensureRsvpSheet":
        return JSON.stringify(await ensureRsvpSheet(input.color, input.slug));
      case "deploySite":
        return JSON.stringify(await deploySite(input.color, input.slug));
      case "attachDomain":
        return JSON.stringify(await attachDomain(input.slug, input.domain));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: err?.message ?? String(err) });
  }
}

export type AgentResult = {
  text: string;
  facts: { liveUrl?: string; sheetUrl?: string; slug?: string; commitSha?: string };
};

const TOOL_LABELS: Record<string, string> = {
  readTemplate: "Reading template",
  readClientSite: "Reading current site",
  ensureVercelProject: "Reserving Vercel project",
  ensureRsvpSheet: "Setting up RSVP sheet",
  createFromTemplate: "Writing site to GitHub",
  editClientSite: "Applying edits to GitHub",
  deploySite: "Deploying to Vercel",
  attachDomain: "Attaching custom domain",
};

export async function runAgent(
  userPrompt: string,
  onProgress?: (label: string) => void
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  const facts: AgentResult["facts"] = {};

  for (let turn = 0; turn < 20; turn++) {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence") {
      const finalText = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: finalText || "(agent ended with no text)", facts };
    }

    if (res.stop_reason !== "tool_use") {
      return { text: `(agent stopped: ${res.stop_reason})`, facts };
    }

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const label = TOOL_LABELS[use.name] ?? use.name;
      console.log(`[tool] ${use.name} input=${JSON.stringify(use.input).slice(0, 200)}`);
      onProgress?.(label);
      const output = await dispatchTool(use.name, use.input);

      try {
        const parsed = JSON.parse(output);
        if (use.name === "ensureVercelProject" && parsed?.slug) facts.slug = parsed.slug;
        if (use.name === "ensureVercelProject" && parsed?.productionUrl) facts.liveUrl = parsed.productionUrl;
        if (use.name === "ensureRsvpSheet" && parsed?.sheetUrl) facts.sheetUrl = parsed.sheetUrl;
        if (use.name === "deploySite" && parsed?.deploymentUrl) facts.liveUrl = parsed.deploymentUrl;
        if ((use.name === "createFromTemplate" || use.name === "editClientSite") && parsed?.commitSha) {
          facts.commitSha = parsed.commitSha;
        }
      } catch {
        // raw text outputs (readTemplate/readClientSite) — ignore
      }

      const isLargeRead = use.name === "readTemplate" || use.name === "readClientSite";
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: [
          {
            type: "text",
            text: output.slice(0, 100_000),
            ...(isLargeRead ? { cache_control: { type: "ephemeral" } } : {}),
          },
        ] as any,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { text: "(agent exceeded turn limit)", facts };
}
