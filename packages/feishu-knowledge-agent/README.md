# Feishu Knowledge Agent

This package is the first MVP backend for a Feishu-first knowledge assistant.

It supports two flows:

1. Send product links to the Feishu bot. The service extracts content, asks Pi Agent to summarize/classify it, writes a local knowledge archive, optionally writes a Feishu Bitable row, and replies in chat.
2. Ask the Feishu bot a recommendation question. The service searches the collected records and asks Pi Agent to compare candidates and answer with sources.

Longer tasks use an interactive Feishu progress card. Mark sends one card immediately, updates it while it reads links or searches records, and replaces the same card with the final result when the work is done.

Mark first classifies each Feishu message into one of four intents:

- `archive_links`: save and analyze links.
- `ask_question`: answer recommendation or comparison questions from saved records.
- `list_records`: list recent or matching records.
- `server_status`: report Mark server health and Tencent Cloud CVM metrics.
- `help`: explain how to use Mark.

## Run Locally

```bash
cp packages/feishu-knowledge-agent/.env.example packages/feishu-knowledge-agent/.env
# Fill Feishu credentials and optional X/Bitable settings.
npm install
npm --workspace=packages/feishu-knowledge-agent run dev
```

Health check:

```bash
curl http://127.0.0.1:8788/health
```

Feishu event callback:

```text
https://your-domain.example.com/feishu/events
```

For local development, expose the service with a tunnel and paste the HTTPS URL into Feishu Open Platform.

## Environment

Required for Feishu chat replies:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`

Recommended:

- `FEISHU_ENCRYPT_KEY`: enables Feishu signature verification.
- `MARK_LLM_BASE_URL`, `MARK_LLM_API_KEY`, and `MARK_LLM_MODEL`: OpenAI-compatible LLM used for link analysis and recommendation answers. Mark tries this before Pi Agent.
- `X_BEARER_TOKEN`: makes X/Twitter extraction reliable.
- `FEISHU_BITABLE_APP_TOKEN` and `FEISHU_BITABLE_TABLE_ID`: writes structured rows into Bitable.
- `PI_AGENT_BINARY`: the Pi binary called for analysis. Defaults to `pi`.
- `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY`, `TENCENTCLOUD_REGION`, and `TENCENTCLOUD_CVM_INSTANCE_ID`: enables Tencent Cloud CVM status and monitor metrics.

## Analysis Model

Mark analyzes collected links in this order:

1. OpenAI-compatible LLM API when `MARK_LLM_API_KEY` is configured.
2. Pi Agent CLI through `PI_AGENT_BINARY`.
3. A simple local heuristic fallback.

For thebestai.net with DeepSeek:

```bash
MARK_LLM_BASE_URL=https://thebestai.net/v1
MARK_LLM_MODEL=deepseek-chat
MARK_LLM_API_KEY=sk_xxx
```

## Bilibili Extraction

Mark calls the Bilibili web APIs directly. There is no Python, virtualenv, or
subprocess involved.

Provide your Bilibili login cookie either as environment variables:

```bash
BILIBILI_SESSDATA=xxx
BILIBILI_BILI_JCT=xxx
BILIBILI_BUVID3=xxx
```

or as a JSON file at `vendor/bilibili_config.json` (the environment variables win when set):

```bash
cp packages/feishu-knowledge-agent/vendor/bilibili_config.example.json packages/feishu-knowledge-agent/vendor/bilibili_config.json
```

`vendor/bilibili_config.json` is ignored by Git because it contains your login cookie.

### How a video is read

1. `web-interface/view` for title, uploader, duration, and description.
2. `player/wbi/v2` for subtitle tracks, falling back to the legacy `player/v2`. Some
   videos only appear on the legacy endpoint.
3. Chinese tracks only, including AI-generated ones (`lan` starting with `ai-zh`).
4. Two sanity checks. Bilibili sometimes returns a track whose content belongs to a
   completely different video, and the garbage differs between requests. Those responses
   run at 0-3 lines per minute while every verified transcript stayed above 18, so tracks
   under 10 lines per minute are discarded. A track whose last cue lands before the
   halfway point of the video is discarded too. For a multi-part video only the first
   part is transcribed, and both checks use that part's length, not the total.

When no usable subtitle exists, Mark archives the video title, uploader, duration, and
description instead, prefixed with a `【内容来源说明】` notice so the analysis model states
the limitation rather than guessing what the video says.

Optional environment overrides:

- `BILIBILI_CONFIG_FILE`: use a different Bilibili cookie JSON file.
- `BILIBILI_TIMEOUT_MS`: per-request timeout. Defaults to 20000.
- `BILIBILI_TRANSCRIPT_COMMAND`: custom JSON-producing command. If set, it bypasses the built-in extractor.

## Browsable Feishu Doc

The archive is mirrored into a Feishu doc so it can be read from chat instead of
only from `.knowledge/knowledge.md` on the server.

Create the doc once:

```bash
npm --workspace=packages/feishu-knowledge-agent run doc:create
```

Put the printed id in `FEISHU_DOC_ID`. You can also paste a full docx or Wiki URL into
`FEISHU_DOC_URL`; Mark will keep that browsable URL in chat replies and resolve the
real document id internally when syncing.

A doc created with `tenant_access_token` is only visible to the app itself, so open it
in Feishu once and add yourself or a group as a collaborator.

After every archive the doc is rebuilt from `records.json`, so it never drifts from the
store. The sync also runs after deletions. Mark understands deletion requests such as
`删除 + 原链接` or `去掉某某项目`; if too many similar records match, it asks for a more
specific title or link before deleting. The sync runs after the result card is sent and
only logs on failure: the local store is the source of truth and a doc problem must not
make a successful archive or deletion look failed. Archive, delete, list, and help
replies link to the doc when `FEISHU_DOC_ID` or `FEISHU_DOC_URL` is set.

Each new record also stores `sharer`, the Feishu sender id of the person who sent the
link to Mark. This is shown in chat replies, the local markdown mirror, the Feishu doc,
and the optional Bitable field configured by `FEISHU_FIELD_SHARER`.

Mark tries to resolve that Feishu sender id into a readable display name before saving
the record. This uses Feishu Contact API `contact/v3/users/{user_id}` with
`user_id_type=open_id`, which requires one of Feishu's contact read scopes such as
`contact:contact.base:readonly`. If that scope is missing, Mark falls back to a generic
`飞书用户` label in human-facing replies and documents instead of showing a raw `ou_...`
id.


## Local Knowledge Files

By default the service writes:

- `.knowledge/records.json`
- `.knowledge/knowledge.md`

These files are the local fallback knowledge base. Bitable and a vector database can be added without changing the Feishu interaction contract.

## Agent Behavior

Mark now plans before it acts. Each Feishu message is first turned into an agent action
such as archiving links, answering from saved records, deleting records, translating
English records to Chinese, checking servers, or asking a clarifying question.

This makes document-cleanup requests work more naturally. For example, a message like
`文档里面有一个是英文的，帮我改成中文的` is treated as a knowledge-document cleanup task:
Mark first reads the configured Feishu Wiki/docx page, finds English-heavy text blocks,
rewrites those blocks in Chinese, and writes them back to the same document. If the
document cannot be read or has no obvious English block, Mark falls back to saved
records: it rewrites English-heavy title, summary, category, tags, use cases, and key
points, then syncs the Feishu doc mirror. If too many records match, Mark asks the user
to choose instead of editing blindly.

## Server Monitoring

Ask Mark in Feishu:

```text
看一下服务器状态
腾讯云负载怎么样
Mark 服务器还好吗
```

Mark always reports local host status from the machine it runs on: uptime, CPU load, memory, root disk, PM2 status, and Caddy status.

If Tencent Cloud credentials are configured, Mark also calls Tencent Cloud API 3.0:

- CVM `DescribeInstances` for instance name, state, and IPs.
- Monitor `GetMonitorData` for metrics such as `CpuUsage`, `MemUsage`, `CvmDiskUsage`, `WanIntraffic`, `WanOuttraffic`, and `TcpCurrEstab`.

Required environment variables:

```bash
TENCENTCLOUD_SECRET_ID=AKIDxxx
TENCENTCLOUD_SECRET_KEY=xxx
TENCENTCLOUD_REGION=ap-guangzhou
TENCENTCLOUD_CVM_INSTANCE_ID=ins-xxxxxxxx
```

For many servers, use `TENCENTCLOUD_CVM_INSTANCES` instead of the single-instance variables:

```bash
TENCENTCLOUD_CVM_INSTANCES=ap-guangzhou:ins-xxxx:Mark主机,ap-shanghai:ins-yyyy:数据库,ap-beijing:ins-zzzz:爬虫机
```

Each item is:

```text
region:instance_id:alias
```

The alias is optional but recommended. With aliases configured, you can ask Mark:

```text
看一下全部服务器状态
看一下数据库服务器
Mark 主机负载怎么样
```

Optional overrides:

```bash
TENCENTCLOUD_MONITOR_NAMESPACE=QCE/CVM
TENCENTCLOUD_MONITOR_DIMENSION_NAME=InstanceId
TENCENTCLOUD_MONITOR_METRICS=CpuUsage,CpuLoadavg,MemUsage,CvmDiskUsage,WanIntraffic,WanOuttraffic,TcpCurrEstab
TENCENTCLOUD_MONITOR_PERIOD=60
TENCENTCLOUD_MONITOR_WINDOW_MINUTES=10
```

Use a read-only CAM policy for the key. The bot only needs permission to read CVM instance details and Cloud Monitor data.

## Next Steps

- Replace the CJK bigram search in `KnowledgeStore.search()` with pgvector or another vector store.
- Add card action buttons: recategorize, delete, ask follow-up.
- Upgrade progress cards to native Feishu CardKit streaming updates if richer token-by-token output is needed.
- Add a queued worker so webhook responses stay fast under long extraction jobs.
- Add recent error-log summaries to server monitoring replies.
