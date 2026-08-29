# Feishu Mark Agent

Mark is a Feishu-first knowledge agent for teams that collect product links, open-source projects, articles, videos, and social posts.

Send Mark a link in Feishu. It reads the source, summarizes the useful parts, classifies the item, stores the record, and keeps a browsable Feishu Wiki page up to date. Later, teammates can ask natural-language questions such as "recommend a web search API for an agent project" and Mark answers from the collected knowledge base.

## What Mark Does

- Collects links from Feishu private chats or group chats.
- Extracts content from GitHub repositories, articles, X/Twitter links, and Bilibili videos.
- Fetches Bilibili subtitles when available, then summarizes the actual video content.
- Writes structured records with title, summary, category, tags, use cases, key points, source link, and sharer.
- Mirrors the archive into a Feishu Wiki or docx page for human browsing.
- Answers recommendation and comparison questions from saved records.
- Edits the Feishu knowledge document, such as translating English-heavy sections into Chinese.
- Reports host and Tencent Cloud server status when configured.

## Product Flow

```text
Feishu chat
  -> Mark webhook server
  -> agent planner
  -> content tools / Feishu tools / server tools
  -> local knowledge store
  -> Feishu reply + Feishu Wiki update
```

The planner is the agent brain. It turns a natural-language message into an action such as collecting links, answering a question, listing records, deleting records, editing the Wiki, checking servers, or asking a clarifying question.

## Repository Layout

```text
packages/feishu-knowledge-agent/   Feishu bot backend for Mark
packages/agent/                    Pi agent runtime used by the monorepo
packages/ai/                       Multi-provider LLM client utilities
packages/coding-agent/             Pi coding-agent CLI
packages/tui/                      Terminal UI package
```

Mark lives in `packages/feishu-knowledge-agent`. The other packages are retained from the Pi Agent codebase because Mark can reuse the agent runtime and CLI as it grows.

## Quick Start

```bash
npm install
cp packages/feishu-knowledge-agent/.env.example packages/feishu-knowledge-agent/.env
npm run feishu:dev
```

Set the Feishu event callback path to:

```text
https://<your-domain>/feishu/events
```

Health check:

```bash
curl http://127.0.0.1:8788/health
```

## Configuration

Mark is configured with environment variables. Keep real credentials in `.env` or server secrets; do not commit them.

Required for Feishu chat:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`

Recommended:

- `FEISHU_ENCRYPT_KEY`
- `FEISHU_DOC_URL` or `FEISHU_DOC_ID`
- `MARK_LLM_BASE_URL`
- `MARK_LLM_API_KEY`
- `MARK_LLM_MODEL`

Optional integrations:

- `X_BEARER_TOKEN` for more reliable X/Twitter extraction.
- `FEISHU_BITABLE_APP_TOKEN` and `FEISHU_BITABLE_TABLE_ID` for Bitable rows.
- `BILIBILI_SESSDATA`, `BILIBILI_BILI_JCT`, and `BILIBILI_BUVID3` for Bilibili subtitle access.
- `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY`, and CVM instance settings for server monitoring.

## Feishu Permissions

Enable only the scopes your deployment needs:

- Message receive and send permissions for chat interaction.
- Wiki/docx read and write permissions for the browsable knowledge document.
- Contact read permission if you want the sharer field to show display names instead of generic Feishu user labels.
- Bitable permissions only if structured Bitable sync is enabled.

## Development

```bash
npm run feishu:build
npm run feishu:dev
```

The local archive is stored under `packages/feishu-knowledge-agent/.knowledge/` by default. This directory is ignored by Git.

## Security Notes

- `.env`, local knowledge files, Bilibili cookie files, build outputs, and dependencies are ignored by Git.
- Use least-privilege Feishu and cloud permissions.
- Rotate any credential that was ever pasted into a chat, terminal, issue, or log.
- Do not commit real App IDs, App Secrets, API keys, server IPs, passwords, or private Wiki links.

## License

MIT
