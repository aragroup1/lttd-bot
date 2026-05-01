import Anthropic from "@anthropic-ai/sdk";
import { config, TEMPLATES, type Template } from "./config.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export type Intent =
  | { kind: "new"; template: Template; rawDetails: string }
  | { kind: "edit"; slug: string; rawDetails: string }
  | { kind: "list" }
  | { kind: "show"; slug: string }
  | { kind: "delete"; slug: string }
  | { kind: "domain"; slug: string; domain: string }
  | { kind: "help" }
  | { kind: "unknown"; reason: string };

function parseFirstLineFast(message: string): Intent | null {
  const trimmed = message.trim();
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  const rest = trimmed.slice(firstLine.length).trim();

  if (/^(help|\/help|\?)$/i.test(firstLine)) return { kind: "help" };

  if (/^list my clients$/i.test(firstLine)) return { kind: "list" };

  const show = firstLine.match(/^show\s+([a-z0-9-]+)$/i);
  if (show) return { kind: "show", slug: show[1].toLowerCase() };

  const del = firstLine.match(/^delete\s+([a-z0-9-]+)\s*!?\s*$/i);
  if (del) return { kind: "delete", slug: del[1].toLowerCase() };

  const dom = firstLine.match(/^domain\s+([a-z0-9-]+)\s+([a-z0-9.-]+\.[a-z]{2,})\s*$/i);
  if (dom) return { kind: "domain", slug: dom[1].toLowerCase(), domain: dom[2].toLowerCase() };

  const nw = firstLine.match(/^new client[, ]+(?:template\s+)?([a-z]+)\b/i);
  if (nw) {
    const template = nw[1].toLowerCase() as Template;
    if ((TEMPLATES as readonly string[]).includes(template)) {
      return { kind: "new", template, rawDetails: rest || firstLine };
    }
  }

  const edit = firstLine.match(/^on\s+([a-z0-9-]+)[, ]+(.*)$/i);
  if (edit) {
    const slug = edit[1].toLowerCase();
    const details = [edit[2], rest].filter(Boolean).join("\n").trim();
    return { kind: "edit", slug, rawDetails: details };
  }

  return null;
}

export async function classifyIntent(message: string): Promise<Intent> {
  const fast = parseFirstLineFast(message);
  if (fast) return fast;

  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system:
      "You classify Telegram messages for a wedding-site bot. Output ONLY minified JSON matching one of:\n" +
      '{"kind":"new","template":"como|orange|pink|purple|red|white","rawDetails":"..."}\n' +
      '{"kind":"edit","slug":"...","rawDetails":"..."}\n' +
      '{"kind":"list"}\n' +
      '{"kind":"show","slug":"..."}\n' +
      '{"kind":"unknown","reason":"..."}\n' +
      "Slugs are lowercase hyphenated. rawDetails is the user's original message minus any routing prefix.",
    messages: [{ role: "user", content: message }],
  });

  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.kind === "string") return parsed as Intent;
  } catch {
    // fall through
  }
  return { kind: "unknown", reason: `Could not parse intent from: ${text.slice(0, 200)}` };
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}
