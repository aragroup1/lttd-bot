import "dotenv/config";
import { createHmac } from "node:crypto";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramOwnerIds: required("TELEGRAM_OWNER_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n)),
  githubToken: required("GITHUB_TOKEN"),
  githubRepo: required("GITHUB_REPO"),
  vercelToken: required("VERCEL_TOKEN"),
  vercelTeamId: process.env.VERCEL_TEAM_ID || undefined,
  googleServiceAccountJson: required("GOOGLE_SERVICE_ACCOUNT_JSON"),
  publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
  rsvpSecret: process.env.RSVP_SECRET || required("TELEGRAM_BOT_TOKEN"),
  port: Number(process.env.PORT) || 3000,
};

export function rsvpSign(slug: string, sheetId: string): string {
  return createHmac("sha256", config.rsvpSecret)
    .update(`${slug}:${sheetId}`)
    .digest("hex")
    .slice(0, 16);
}

export const [githubOwner, githubRepoName] = config.githubRepo.split("/");

export const TEMPLATES = ["como", "orange", "pink", "purple", "red", "white"] as const;
export type Template = (typeof TEMPLATES)[number];
