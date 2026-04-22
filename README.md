# lttd-bot

Telegram bot that drives the **LinkToTheDay** wedding-site pipeline. Owner DMs the bot → a Claude Agent edits/creates a client folder in `aragroup1/LinkToYourDay`, ensures a Vercel project, and replies with the deployed URL.

## Stack

- Node 20 + TypeScript
- `grammy` — Telegram
- `@anthropic-ai/claude-agent-sdk` — agent loop
- `@octokit/rest` — GitHub Contents API
- Vercel REST API via `fetch`

## Message conventions

- **New client:** first line `New client, <template>` where template ∈ `como|orange|pink|purple|red|white`. Rest of the message is free-text details.
- **Edit:** first line `On <slug>, <what to change>`.
- **Utility:** `List my clients`, `Show <slug>`.

## Environment variables

| Name | Description |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic console key |
| `TELEGRAM_BOT_TOKEN` | From `@BotFather` |
| `TELEGRAM_OWNER_IDS` | Comma-separated Telegram user IDs allowed to DM the bot |
| `GITHUB_TOKEN` | Fine-grained PAT, `Contents: read/write` on `aragroup1/LinkToYourDay` |
| `GITHUB_REPO` | `aragroup1/LinkToYourDay` |
| `VERCEL_TOKEN` | From vercel.com/account/tokens |
| `VERCEL_TEAM_ID` | Optional, if the Vercel account is a team |

## Local run

```
npm install
npm run build
node dist/index.js
```

With a local `.env` containing the variables above.

## Deploy

Railway → Deploy from GitHub → select `aragroup1/lttd-bot`. Set the env vars. Nixpacks auto-detects Node and runs `npm start` (which runs `node dist/index.js` after the build step).

## Project layout

```
src/
  index.ts         # grammy bot entry, allowlist, message routing
  agent.ts         # Claude Agent SDK setup, system prompt, tool wiring
  intent.ts        # fast first-line parser + Haiku fallback
  config.ts        # env parsing + template list
  tools/
    github.ts      # readTemplate / readClientSite / writeClientSite / listClients
    vercel.ts      # ensureVercelProject / triggerDeploy
```
