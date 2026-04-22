import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readTemplate, readClientSite, writeClientSite } from "./tools/github.js";
import { ensureVercelProject, triggerDeploy } from "./tools/vercel.js";
import { TEMPLATES } from "./config.js";

const SYSTEM_PROMPT = `You are the LinkToTheDay site builder. You edit wedding microsites stored at <template>/<slug>/index.html in the GitHub repo.

Templates available: ${TEMPLATES.join(", ")}.

Folder convention: <template>/<slug>/index.html. Slugs are lowercase, hyphenated, derived from the couple's names (strip & / "and"). Example: "Sarah Ahmed & Tom Wright" -> "sarah-ahmed-tom-wright".

Rules:
- For NEW clients: call readTemplate(color), apply the user's details (names, date, venue, RSVP, section add/remove), then writeClientSite(color, slug, html, commitMessage). Preserve the template's structure, styling, and script tags — only change copy/dates and add/remove sections the user asked for.
- For EDITS: call readClientSite(color, slug), apply the requested diff, then writeClientSite. Do not rewrite unrelated sections.
- After writing, call ensureVercelProject(color, slug) and then triggerDeploy(projectId, name, commitSha).
- Respond with a single short final message containing: the live URL, the slug, and a one-line changelog.
- Keep commit messages concise (<72 chars), e.g. "como/sarah-tom: initial site" or "como/sarah-tom: update date to 22 Aug".`;

const siteTools = createSdkMcpServer({
  name: "lttd-site-tools",
  version: "0.1.0",
  tools: [
    tool(
      "readTemplate",
      "Read the base HTML template for a given color (como, orange, pink, purple, red, white).",
      { color: z.string() },
      async ({ color }) => {
        const html = await readTemplate(color);
        return { content: [{ type: "text", text: html }] };
      }
    ),
    tool(
      "readClientSite",
      "Read an existing client's index.html at <color>/<slug>/index.html.",
      { color: z.string(), slug: z.string() },
      async ({ color, slug }) => {
        const html = await readClientSite(color, slug);
        return { content: [{ type: "text", text: html }] };
      }
    ),
    tool(
      "writeClientSite",
      "Create or update <color>/<slug>/index.html on main. Returns commitSha and path.",
      {
        color: z.string(),
        slug: z.string(),
        html: z.string(),
        commitMessage: z.string(),
      },
      async ({ color, slug, html, commitMessage }) => {
        const res = await writeClientSite(color, slug, html, commitMessage);
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
    ),
    tool(
      "ensureVercelProject",
      "Idempotent: find or create the Vercel project lttd-<color>-<slug> pointing at <color>/<slug> in the repo.",
      { color: z.string(), slug: z.string() },
      async ({ color, slug }) => {
        const res = await ensureVercelProject(color, slug);
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
    ),
    tool(
      "triggerDeploy",
      "Trigger a production deployment and wait until READY. Returns deploymentUrl and state.",
      {
        projectId: z.string(),
        name: z.string(),
        commitSha: z.string().optional(),
      },
      async ({ projectId, name, commitSha }) => {
        const res = await triggerDeploy(projectId, name, commitSha);
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
    ),
  ],
});

const ALLOWED_TOOLS = [
  "mcp__lttd-site-tools__readTemplate",
  "mcp__lttd-site-tools__readClientSite",
  "mcp__lttd-site-tools__writeClientSite",
  "mcp__lttd-site-tools__ensureVercelProject",
  "mcp__lttd-site-tools__triggerDeploy",
];

export async function runAgent(userPrompt: string): Promise<string> {
  const response = query({
    prompt: userPrompt,
    options: {
      model: "claude-opus-4-7",
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { "lttd-site-tools": siteTools },
      allowedTools: ALLOWED_TOOLS,
      permissionMode: "bypassPermissions",
    },
  });

  let finalText = "";
  for await (const event of response) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") finalText = block.text;
      }
    } else if (event.type === "result") {
      if (event.subtype === "success" && event.result) finalText = event.result;
    }
  }
  return finalText || "(agent returned no text)";
}
