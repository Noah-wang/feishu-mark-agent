<p align="center">
  <img src="packages/feishu-knowledge-agent/assets/mark-logo.png" alt="Mark" width="132">
</p>

<h1 align="center">Mark</h1>

<p align="center">
  <b>在飞书里丢一个链接，换回一份能检索的团队资料库。</b>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3178C6?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.19-5FA04E?style=flat-square&logo=node.js&logoColor=white">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-1D9E75?style=flat-square">
</p>

---

群里刷过的链接，转头就沉底了。Mark 会读完你发给它的每一个链接，整理成结构化记录，
并持续维护一份团队可以直接翻阅的飞书文档。几周之后你用大白话问一句，它从团队真正
收集过的内容里给你答案，并附上出处。

## 最新更新

**2026-08-31：Monid/TinyFish 浏览器抓取。** Mark 现在可以通过 Monid 的 TinyFish
浏览器抓取能力读取 X/Twitter 和动态网页，把页面转成干净 Markdown 后再分析。X 官方 API
仍可作为可选兜底；真实 `MONID_API_KEY` 只应放在服务器环境变量里。

**2026-08-30：通用决策 Agent。** Mark 现在能处理产品、运营和技术选型：先检索团队资料，
再用脱敏查询自动联网补充，深入读取候选来源后给出带证据的推荐、备选、风险和下一步。
每次结论会保存到独立的“Mark 决策中心”，以后可以继续问“上次为什么选它”。

**2026-08-30：延迟群提醒和撤回窗口。** Mark 现在可以在私聊收录成功后，延迟把同样的
收录卡片发到指定飞书群。管理员可以配置目标群、提醒延迟和可撤回时间；发送者在窗口内
回复 `撤回` 或 `取消提醒`，就能取消这次群提醒，避免把误发链接同步到公开群里。

**2026-08-29：飞书资料库镜像。** 收录内容会同步到可浏览的飞书 Wiki/docx 文档，聊天
回复、列表和删除结果都会带上资料库入口，方便团队直接翻阅。

## 实际效果

**发一个链接。** Mark 立刻回一张卡片，然后在读取、分析、归档的过程中原地更新它，不会让你干等。

> ### 收录完成
>
> **已收录**：Monid：面向 AI Agent 的免费网页搜索与抓取服务
> **分类**：AI 工具
> **标签**：免费 API、网页搜索、AI Agent
> **摘要**：TinyFish 推出的免费网页搜索和页面抓取服务，主打零成本替代 Exa、Tavily、SerpAPI 和 Brave。
> **原链接**：https://x.com/shengkunye/status/2093050916953903451
> **资料库文档**：https://feishu.cn/docx/...

**几周后再问它。**

> 给我推荐一个做 B 站字幕提取的工具

Mark 检索资料库，给出带取舍分析的回答，只引用团队实际收录过的记录，并附上原链接。

**其他可以直接说的话：**

| 你说 | Mark 做 |
|---|---|
| *（直接粘任意链接）* | 读取、摘要、分类、归档 |
| 预算每月 3000 元，帮我选一个社媒监测方案 | 内部检索、联网研究、比较并保存决策 |
| 上次为什么没选另一个方案 | 基于当时的决策记录复盘 |
| 列出最近收录的 10 个项目 | 列出最近或匹配的记录 |
| 把这条删掉 + *（链接）* | 删除记录并重新同步文档 |
| 把文档里的英文改成中文 | 改写飞书文档里的英文段落 |
| 看一下服务器状态 | 报告本机和腾讯云 CVM 指标 |

## 支持的来源

| 来源 | 抓取方式 |
|---|---|
| GitHub | 仓库 API + README，含 star 数、语言、许可证 |
| B 站 | 通过 B 站 web 接口拿中文字幕，含 AI 生成的字幕轨 |
| X / Twitter | Monid/TinyFish 浏览器抓取，X API 可选兜底 |
| 文章网页 | Monid/TinyFish 浏览器抓取，Open Graph 元信息可选兜底 |

B 站有时会返回一条**属于完全无关视频的字幕轨**，而且每次请求返回的内容还不一样。
Mark 会丢弃密度低于 10 行每分钟、或最后一句时间戳落在视频前半段的字幕轨，改为归档
视频元信息，并在正文开头标注来源受限，避免模型凭空编造视频讲了什么。多分P 视频只
抓取第一个分P，两项校验也按该分P的时长计算。

## 工作原理

```text
飞书消息
      │
      ▼
  webhook 服务 ──► 规划器 ──► 收录 · 问答 · 列表 · 删除
      │                      决策 Agent · 改文档 · 查服务器
      ▼
  内容抽取 ──► LLM 分析 ──► 本地资料库 ──► 飞书文档 + 回复
```

规划器是这个 agent 的大脑：它把一句自然语言变成一个动作，而不是靠关键词匹配。

每一次 LLM 调用都有降级链——先试 OpenAI 兼容接口，失败落到 Pi agent CLI，再失败落到
本地启发式规则——所以某个服务商挂掉时机器人仍然能回话。

`.knowledge/` 下的本地资料库是唯一真源，飞书文档是它的镜像，每次变更后整份重建，
两边不会出现不一致。

## 快速开始

```bash
npm install
cp packages/feishu-knowledge-agent/.env.example packages/feishu-knowledge-agent/.env
npm run feishu:dev
```

把飞书事件回调地址指向 `https://<你的域名>/feishu/events`，然后验证服务：

```bash
curl http://127.0.0.1:8788/health
```

创建那份可翻阅的资料库文档（只需执行一次）：

```bash
npm --workspace=packages/feishu-knowledge-agent run doc:create
```

把打印出来的 id 填进 `FEISHU_DOC_ID`。用 tenant token 创建的文档默认只有应用自己可见，
所以要在飞书里打开一次，把自己或群组加成协作者，否则你点开是空白。

决策记录使用单独文档，创建方式相同：

```bash
npm --workspace=packages/feishu-knowledge-agent run decision-doc:create
```

## 配置

全部通过环境变量配置。真实凭据放在 `.env` 或服务器 secrets 里，不要提交。

**必填**

| 变量 | 用途 |
|---|---|
| `FEISHU_APP_ID` · `FEISHU_APP_SECRET` | 飞书自建应用凭证 |
| `FEISHU_VERIFICATION_TOKEN` | 校验事件来源 |

**建议配置**

| 变量 | 用途 |
|---|---|
| `FEISHU_ENCRYPT_KEY` | 开启请求签名校验 |
| `FEISHU_DOC_ID` 或 `FEISHU_DOC_URL` | 可翻阅的资料库文档 |
| `MARK_LLM_BASE_URL` · `MARK_LLM_API_KEY` · `MARK_LLM_MODEL` | OpenAI 兼容接口，用于摘要和问答 |
| `MARK_WEB_SEARCH_API_KEY` | Brave Search API key，用于决策 Agent 自动联网研究 |
| `FEISHU_DECISION_DOC_ID` 或 `FEISHU_DECISION_DOC_URL` | 独立的 Mark 决策中心文档 |
| `MONID_API_KEY` | Monid/TinyFish 浏览器抓取，用于 X 和动态网页 |

**可选集成**

| 变量 | 用途 |
|---|---|
| `BILIBILI_SESSDATA` · `BILIBILI_BILI_JCT` · `BILIBILI_BUVID3` | B 站字幕访问 |
| `X_BEARER_TOKEN` | X/Twitter 官方 API 兜底 |
| `FEISHU_BITABLE_APP_TOKEN` · `FEISHU_BITABLE_TABLE_ID` | 同步结构化多维表格 |
| `FEISHU_ARCHIVE_REMINDER_CHAT_ID` | 收录后延迟提醒指定飞书群 |
| `TENCENTCLOUD_SECRET_ID` · `TENCENTCLOUD_SECRET_KEY` | 腾讯云 CVM 状态和监控指标 |

完整列表见 [`.env.example`](packages/feishu-knowledge-agent/.env.example)。

## 飞书权限

按实际用到的功能开，不要多给：

- **消息** — 接收和发送消息、更新卡片。
- **`docx:document`** — 资料库文档必需。
- **通讯录读取** — 可选，开了之后分享者字段显示真实姓名而不是通用标识。
- **多维表格** — 只在启用 Bitable 同步时需要。

## 本地开发

```bash
npm run feishu:build   # 类型检查并编译到 dist/
npm run feishu:dev     # 用 tsx 直接跑源码
```

资料库默认写在 `packages/feishu-knowledge-agent/.knowledge/`，已被 Git 忽略。

## 仓库结构

Mark 是 `packages/feishu-knowledge-agent`，一个零运行时依赖的独立服务。其余包来自本仓库
fork 的 [Pi agent](https://github.com/earendil-works/pi-mono) 代码库，保留下来是为了 Mark
后续能复用它的 agent 运行时。

```text
packages/feishu-knowledge-agent/   Mark，飞书机器人后端
packages/agent/                    Pi agent 运行时
packages/ai/                       多厂商 LLM 客户端
packages/coding-agent/             Pi 编码 agent CLI
packages/tui/                      终端 UI 库
```

## 安全

- `.env`、本地资料库、B 站 cookie 文件、构建产物都已被 Git 忽略。
- 决策 Agent 联网前会移除私有 URL、IP、邮箱、飞书 id 和常见凭据格式。
- 飞书和云服务的凭据按最小权限配置。
- 任何在聊天、终端、issue 或日志里出现过的凭据，一律重置。
- 不要提交 App Secret、API key、服务器地址或私有文档链接。

## License

MIT
