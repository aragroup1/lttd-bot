import Anthropic from "@anthropic-ai/sdk";
import { config, TEMPLATES } from "./config.js";
import { readTemplate, readClientSite, writeClientSite } from "./tools/github.js";
import { ensureVercelProject, triggerDeploy } from "./tools/vercel.js";
import { ensureRsvpSheet } from "./tools/google.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are the LinkToTheDay site builder. You edit wedding microsites stored at <template>/<slug>/index.html in the GitHub repo.

Templates available: ${TEMPLATES.join(", ")}.

Folder convention: <template>/<slug>/index.html. Slugs are lowercase, hyphenated, derived from the couple's first names only (strip surnames, & and "and"). Examples: "Sarah Ahmed & Tom Wright" -> "sarah-tom". "Arman & Faiza" -> "arman-faiza". If the user provides a "Required slug" in the prompt, use it verbatim without modification.

Do NOT ask the user to confirm the slug. Proceed using the suggested/required slug directly. The only time to stop and reply with a question is when a tool returns SLUG_TAKEN — in that case, reply with the exact instruction from the tool error (telling the user to resend with a "Slug: <alternative>" line).

Rules:
- For NEW clients: call readTemplate(color), apply the user's details (names, date, venue, section add/remove), then wire up RSVP (see below), then writeClientSite(color, slug, html, commitMessage). Preserve the template's structure, styling, and script tags. Only change copy/dates and add/remove sections the user asked for. DO NOT add or remove form fields — use whatever is already in the template.
- For EDITS: call readClientSite(color, slug), apply the requested diff, then writeClientSite. Do not rewrite unrelated sections. If the template color is unknown, try readClientSite on each template until one succeeds.

RSVP wiring (NEW clients only — skip for edits unless explicitly asked):
1. Call ensureRsvpSheet(color, slug) — returns {sheetId, sheetUrl}.
2. In the HTML, find the existing <form> element (if any). Modify it IN PLACE:
   - Set method="POST" and action="${config.publicUrl}/rsvp".
   - Add attribute enctype="application/x-www-form-urlencoded" if not present.
   - Inside the form, insert <input type="hidden" name="sheetId" value="<sheetId>"> and <input type="hidden" name="slug" value="<slug>">.
   - Ensure existing inputs have sensible name attributes. Common names: name, attending, guests, dietary, message. If inputs have different names, keep them (they'll still be captured in the Raw column).
   - After the form, optionally add: <p id="rsvp-thanks" style="display:none">Thanks — your RSVP was recorded.</p>
   - Just before </form> or </body>, add a tiny submit handler that posts via fetch and shows the thanks message without navigating away:
     <script>
     document.querySelector('form').addEventListener('submit', async (e) => {
       e.preventDefault();
       const fd = new FormData(e.target);
       await fetch(e.target.action, { method: 'POST', body: new URLSearchParams(fd) });
       e.target.style.display = 'none';
       const t = document.getElementById('rsvp-thanks'); if (t) t.style.display = 'block';
     });
     </script>
3. If the template has NO form, skip RSVP wiring silently.

After writing: call ensureVercelProject(color, slug), then triggerDeploy(projectId, name, commitSha).

Final reply: one short message with the live URL, the slug, the RSVP sheet URL (if created), and a one-line changelog.
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
    name: "writeClientSite",
    description: "Create or update <color>/<slug>/index.html on main. Returns {commitSha, path}.",
    input_schema: {
      type: "object",
      properties: {
        color: { type: "string" },
        slug: { type: "string" },
        html: { type: "string" },
        commitMessage: { type: "string" },
      },
      required: ["color", "slug", "html", "commitMessage"],
    },
  },
  {
    name: "ensureVercelProject",
    description: "Idempotent: find or create the Vercel project lttd-<color>-<slug> pointing at <color>/<slug> in the repo. Returns {projectId, name, productionUrl}.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" }, slug: { type: "string" } },
      required: ["color", "slug"],
    },
  },
  {
    name: "ensureRsvpSheet",
    description: "Create (or find) the Google Sheet for this client's RSVP responses. Returns {sheetId, sheetUrl, name}. The sheet is publicly viewable; anyone with the URL can read it.",
    input_schema: {
      type: "object",
      properties: { color: { type: "string" }, slug: { type: "string" } },
      required: ["color", "slug"],
    },
  },
  {
    name: "triggerDeploy",
    description: "Trigger a production deployment and wait until READY. Returns {deploymentUrl, state}.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        name: { type: "string" },
        commitSha: { type: "string" },
      },
      required: ["projectId", "name"],
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
      case "writeClientSite":
        return JSON.stringify(
          await writeClientSite(input.color, input.slug, input.html, input.commitMessage)
        );
      case "ensureVercelProject":
        return JSON.stringify(await ensureVercelProject(input.color, input.slug));
      case "ensureRsvpSheet":
        return JSON.stringify(await ensureRsvpSheet(input.color, input.slug));
      case "triggerDeploy":
        return JSON.stringify(await triggerDeploy(input.projectId, input.name, input.commitSha));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: err?.message ?? String(err) });
  }
}

export async function runAgent(userPrompt: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

  for (let turn = 0; turn < 20; turn++) {
    const res = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
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
      return finalText || "(agent ended with no text)";
    }

    if (res.stop_reason !== "tool_use") {
      return `(agent stopped: ${res.stop_reason})`;
    }

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      console.log(`[tool] ${use.name} input=${JSON.stringify(use.input).slice(0, 200)}`);
      const output = await dispatchTool(use.name, use.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: output.slice(0, 100_000),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "(agent exceeded turn limit)";
}
