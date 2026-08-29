import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type {
	AgentActionName,
	AgentPlan,
	ExtractedContent,
	KnowledgeRecord,
	MessageIntent,
	MessageIntentName,
	Recommendation,
	RequirementPoint,
} from "./types.js";
import { SOURCE_TYPE_LABELS } from "./types.js";

const VALID_INTENTS = new Set<MessageIntentName>([
	"archive_links",
	"ask_question",
	"list_records",
	"delete_records",
	"server_status",
	"help",
]);

const VALID_AGENT_ACTIONS = new Set<AgentActionName>([
	"archive_links",
	"ask_question",
	"list_records",
	"delete_records",
	"translate_records",
	"server_status",
	"help",
	"clarify",
]);

export async function planAgentAction(text: string, urls: string[], config: Config): Promise<AgentPlan> {
	const prompt = `You are Mark, an agent living in Feishu chat. You are not a menu router.

Your job is to understand the user's goal, choose the best tool, and ask a clarifying question only when the goal cannot be safely acted on.

Available tools:
- archive_links: save, summarize, classify, and tag URLs sent by the user.
- ask_question: answer recommendations or comparisons using saved records.
- list_records: list, browse, count, or inspect saved records.
- delete_records: remove saved records from the knowledge base.
- translate_records: rewrite saved records that contain English into Simplified Chinese, then sync the Feishu knowledge document.
- server_status: inspect Mark host or Tencent Cloud server status.
- help: explain what Mark can do.
- clarify: ask one focused follow-up question before acting.

Important behavior:
- If the user says a document has English and asks to make it Chinese, use translate_records. Do not treat it as a recommendation question.
- If the user wants to edit, rewrite, translate, clean up, or organize the knowledge document, prefer translate_records or list_records instead of ask_question.
- If the request is dangerously broad, ambiguous, or could delete many records, use clarify.
- If URLs are present and the user does not ask about existing records, use archive_links.
- Return strict JSON only.

Schema:
{
  "action": "archive_links | ask_question | list_records | delete_records | translate_records | server_status | help | clarify",
  "query": "cleaned user goal in Chinese",
  "reason": "short Chinese reason",
  "question": "only when action is clarify; one Chinese question"
}

Message:
${text}

URLs:
${urls.join("\n") || "(none)"}`;

	const result = await runLlmJson(prompt, config).catch(() => undefined);
	return normalizeAgentPlan(result, text, urls);
}

export async function classifyMessageIntent(text: string, urls: string[], config: Config): Promise<MessageIntent> {
	const prompt = `You are routing a Feishu bot message for Mark, a company knowledge assistant.

Decide the user's intent. Return strict JSON only.

Allowed intents:
- archive_links: user wants to save, collect, mark, bookmark, summarize, classify, or add links to the knowledge base.
- ask_question: user asks for a recommendation, comparison, analysis, or answer based on saved records.
- list_records: user asks to list, show, browse, count, or review existing saved records.
- delete_records: user wants to delete, remove, clear, hide, or take saved records out of the knowledge base.
- server_status: user asks for Mark server, Tencent Cloud CVM, host health, CPU, memory, disk, network, PM2, Caddy, uptime, or monitoring status.
- help: user asks what Mark can do or how to use it.

Rules:
- If the user asks to delete/remove/clear/take out saved knowledge, prefer delete_records even when URLs are present.
- If URLs are present and the user does not clearly ask a question about existing records, prefer archive_links.
- If there are no URLs and the user asks for tools, services, projects, recommendations, or "which one", prefer ask_question.
- Do not invent actions outside the allowed intents.

Return schema:
{
  "intent": "archive_links | ask_question | list_records | delete_records | server_status | help",
  "query": "cleaned user request in Chinese",
  "reason": "short Chinese reason"
}

Message:
${text}

URLs:
${urls.join("\n") || "(none)"}`;

	const result = await runLlmJson(prompt, config).catch(() => undefined);
	return normalizeIntent(result, text, urls);
}

export async function analyzeForArchive(
	content: ExtractedContent,
	config: Config,
): Promise<Omit<KnowledgeRecord, "id" | "createdAt" | "rawText" | "sharer">> {
	const prompt = `You are organizing a company knowledge base of useful products, open-source projects, articles, and videos.

Return strict JSON only. No markdown.

Schema:
{
  "title": "简短中文标题",
  "summary": "2-4 句中文摘要",
  "category": "一个中文分类",
  "tags": ["中文标签"],
  "useCases": ["中文业务或产品场景"],
  "keyPoints": ["中文要点"]
}

Language rules (most important):
- Every string value must be Simplified Chinese, even when the source content is English or any other language. Translate, do not copy.
- Only keep the original spelling for proper nouns that have no common Chinese name: product names, company names, repo names, and technical terms like API, SDK, LLM, GitHub. Everything around them is Chinese.
- "title" is a Chinese description of what this is, and may embed the product name, e.g. "Monid：面向 AI Agent 的免费网页搜索与抓取服务".
- Never return an English sentence in any field.

Category rules:
- Prefer one of: AI 工具、开源项目、开发框架、模型与算法、产品设计、行业观察、教程与经验、视频内容。
- If none fits, write your own short Chinese category. Never use an English category.

Honesty rules:
- If the content starts with 【内容来源说明】, that notice describes what you actually received. Respect it: summarize only what the provided text supports, state the limitation in the summary, and never guess what a video says when its transcript was not provided.
- Never invent details that are not in the provided content.

Source URL: ${content.url}
Source type: ${content.sourceType}
Title: ${content.title}
Metadata: ${JSON.stringify(content.metadata).slice(0, 4000)}
Content:
${content.text.slice(0, 24000)}`;

	const result = await runLlmJson(prompt, config)
		.catch(() => runPiJson(prompt, config))
		.catch(() => undefined);
	const parsed = result ?? heuristicArchive(content);
	return {
		url: content.url,
		sourceType: content.sourceType,
		title: parsed.title || content.title,
		summary: parsed.summary || content.text.slice(0, 500),
		category: parsed.category || "未分类",
		tags: arrayOfStrings(parsed.tags),
		useCases: arrayOfStrings(parsed.useCases),
		keyPoints: arrayOfStrings(parsed.keyPoints),
		images: content.images,
		metadata: content.metadata,
	};
}

/** Capping this bounds both the number of searches and the size of the answer prompt. */
const MAX_REQUIREMENT_POINTS = 5;

/**
 * Splits a request into the capabilities it needs, so each can be searched on its own.
 * A single-tool question yields one point and behaves exactly like a plain search.
 */
export async function planRequirementPoints(question: string, config: Config): Promise<RequirementPoint[]> {
	const prompt = `You are planning how to answer a request against a knowledge base of products, open-source projects, articles, and videos.

Break the request into the distinct capabilities it needs. Each capability is something a
separate tool or project could provide.

Rules:
- A request naming one tool need yields exactly one point. Do not invent extra points.
- A product idea usually yields two to four points. Never more than ${MAX_REQUIREMENT_POINTS}.
- "need" is a short Chinese phrase naming the capability, not a restatement of the whole request.
- "keywords" are Chinese and English search terms for that capability, space separated, no punctuation.
- Return points in the order they would be built.

Return strict JSON only:
{
  "points": [{"need": "中文能力点", "keywords": "关键词 keywords"}]
}

Request:
${question}`;

	const result = await runLlmJson(prompt, config).catch(() => undefined);
	const points = Array.isArray(result?.points) ? result.points : [];
	const cleaned = points
		.map((point: any) => ({
			need: String(point?.need ?? "").trim(),
			keywords: String(point?.keywords ?? "").trim(),
		}))
		.filter((point: RequirementPoint) => point.need && point.keywords)
		.slice(0, MAX_REQUIREMENT_POINTS);
	// Without an LLM the whole question is one point, which is the old behaviour.
	return cleaned.length ? cleaned : [{ need: question.trim() || "需求", keywords: question.trim() }];
}

export async function answerQuestion(
	question: string,
	points: Array<{ point: RequirementPoint; records: KnowledgeRecord[] }>,
	config: Config,
): Promise<Recommendation> {
	const context = points
		.map(
			(entry, pointIndex) => `能力点 ${pointIndex + 1}：${entry.point.need}
${
	entry.records.length
		? entry.records
				.map(
					(record, index) => `  #${pointIndex + 1}.${index + 1}
  Title: ${record.title}
  URL: ${record.url}
  Category: ${record.category}
  Tags: ${record.tags.join(", ")}
  Summary: ${record.summary}
  Use cases: ${record.useCases.join("; ")}
  Key points: ${record.keyPoints.join("; ")}`,
				)
				.join("\n\n")
		: "  （资料库里没有检索到相关记录）"
}`,
		)
		.join("\n\n");

	const prompt = `You are a Feishu knowledge-base assistant. The user described something they want to build.
Their request was split into capability points, and each point was searched separately.

For every point, pick the collected records that actually help with that point, and say why.
Answer in Simplified Chinese.

Rules:
- Use only the provided records. Never invent a tool that is not listed.
- A record may serve more than one point. A point may have no suitable record.
- When a point has nothing suitable, leave "picks" empty and write in "gap" what kind of tool
  the archive is missing, so the user knows what to go collect.
- When a point is covered, "gap" is an empty string.
- Keep the points in the given order and do not merge or drop any.
- "answer" is a short overall conclusion: what can be built now, and what is blocked.

Language rules:
- "answer", "need", "title", "reason", and "gap" must be Simplified Chinese.
- Keep product names, repo names, and terms like API, SDK, LLM in their original spelling.
- "url" stays exactly as given.

Return strict JSON only:
{
  "answer": "中文总体结论",
  "points": [
    {
      "need": "中文能力点",
      "picks": [{"title": "中文标题", "url": "url", "reason": "中文推荐理由"}],
      "gap": "中文缺口说明，覆盖到了就留空字符串"
    }
  ]
}

Request:
${question}

Capability points and their search results:
${context.slice(0, 30000)}`;

	const result = await runLlmJson(prompt, config)
		.catch(() => runPiJson(prompt, config))
		.catch(() => undefined);

	const parsed = Array.isArray(result?.points) ? result.points : [];
	if (result?.answer && parsed.length) {
		return {
			answer: String(result.answer),
			points: parsed.map((item: any, index: number) => ({
				need: String(item?.need ?? points[index]?.point.need ?? "").trim(),
				picks: Array.isArray(item?.picks)
					? item.picks.map((pick: any) => ({
							title: String(pick?.title ?? ""),
							url: String(pick?.url ?? ""),
							reason: String(pick?.reason ?? ""),
						}))
					: [],
				gap: String(item?.gap ?? "").trim(),
			})),
		};
	}

	return heuristicRecommendation(points);
}

/** Used when no LLM is reachable: report the top search hit per point without analysis. */
function heuristicRecommendation(
	points: Array<{ point: RequirementPoint; records: KnowledgeRecord[] }>,
): Recommendation {
	const covered = points.filter((entry) => entry.records.length).length;
	return {
		answer: covered
			? `我按 ${points.length} 个能力点检索了资料库，其中 ${covered} 个找到了相关资料。下面是每个点最相关的记录。`
			: "目前资料库里还没有能覆盖这个需求的内容。你可以先把相关的链接发给我收录。",
		points: points.map((entry) => ({
			need: entry.point.need,
			picks: entry.records.slice(0, 3).map((record) => ({
				title: record.title,
				url: record.url,
				reason: record.summary,
			})),
			gap: entry.records.length ? "" : "资料库里没有检索到能覆盖这一点的记录。",
		})),
	};
}

export async function translateRecordToChinese(
	record: KnowledgeRecord,
	request: string,
	config: Config,
): Promise<KnowledgeRecord> {
	const prompt = `You are cleaning a company knowledge base record. Rewrite the fields below into Simplified Chinese.

Return strict JSON only:
{
  "title": "简短中文标题，可以保留产品名或项目名",
  "summary": "2-4 句中文摘要",
  "category": "中文分类",
  "tags": ["中文标签"],
  "useCases": ["中文适用场景"],
  "keyPoints": ["中文要点"]
}

Rules:
- Keep product names, GitHub repo names, API, SDK, LLM, and other proper nouns in their original spelling.
- Translate English explanations into natural Simplified Chinese.
- Do not invent facts beyond the record.

User request:
${request}

Record:
Title: ${record.title}
URL: ${record.url}
Category: ${record.category}
Tags: ${record.tags.join(", ")}
Summary: ${record.summary}
Use cases: ${record.useCases.join("; ")}
Key points: ${record.keyPoints.join("; ")}
Raw text:
${record.rawText.slice(0, 16000)}`;

	const result = await runLlmJson(prompt, config)
		.catch(() => runPiJson(prompt, config))
		.catch(() => undefined);
	if (!result) return record;
	const tags = arrayOfStrings(result.tags);
	const useCases = arrayOfStrings(result.useCases);
	const keyPoints = arrayOfStrings(result.keyPoints);
	return {
		...record,
		title: String(result.title || record.title),
		summary: String(result.summary || record.summary),
		category: String(result.category || record.category),
		tags: tags.length ? tags : record.tags,
		useCases: useCases.length ? useCases : record.useCases,
		keyPoints: keyPoints.length ? keyPoints : record.keyPoints,
	};
}

export async function translateTextToChinese(text: string, request: string, config: Config): Promise<string> {
	const prompt = `You are editing a Feishu knowledge-base document. Translate or rewrite the provided text into natural Simplified Chinese.

Return strict JSON only:
{
  "text": "改写后的正文"
}

Rules:
- If the text is already Chinese, keep the meaning and only lightly polish it.
- Translate English explanations into Simplified Chinese.
- Keep product names, company names, GitHub repo names, URLs, API, SDK, LLM, and code-like identifiers in their original spelling.
- Do not add facts, comments, headings, or explanations that are not in the original text.
- Preserve line breaks when they are meaningful.

User request:
${request}

Text:
${text.slice(0, 8000)}`;

	const result = await runLlmJson(prompt, config)
		.catch(() => runPiJson(prompt, config))
		.catch(() => undefined);
	const translated = typeof result?.text === "string" ? result.text.trim() : "";
	return translated || text;
}

async function runPiJson(prompt: string, config: Config): Promise<any> {
	if (!config.pi.binary) throw new Error("PI_AGENT_BINARY is not configured");
	const output = await runCommand(
		config.pi.binary,
		["-p", "--no-session", prompt],
		process.cwd(),
		config.pi.timeoutMs,
	);
	const jsonText = output.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonText) throw new Error("Pi output did not contain JSON");
	return JSON.parse(jsonText);
}

async function runLlmJson(prompt: string, config: Config): Promise<any> {
	if (!config.llm.baseUrl || !config.llm.apiKey || !config.llm.model) {
		throw new Error("LLM service is not configured");
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
	try {
		const response = await fetch(`${config.llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${config.llm.apiKey}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				model: config.llm.model,
				messages: [
					{
						role: "system",
						content: "You return strict JSON only. Do not wrap the response in markdown.",
					},
					{ role: "user", content: prompt },
				],
				temperature: 0.2,
			}),
		});
		const body = (await response.json()) as any;
		if (!response.ok) throw new Error(`LLM request failed: ${JSON.stringify(body).slice(0, 500)}`);
		const text = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? "";
		const jsonText = String(text).match(/\{[\s\S]*\}/)?.[0];
		if (!jsonText) throw new Error("LLM output did not contain JSON");
		return JSON.parse(jsonText);
	} finally {
		clearTimeout(timer);
	}
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: process.env });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Command timed out: ${command}`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Command failed with exit code ${code}`));
		});
	});
}

function heuristicArchive(content: ExtractedContent) {
	const words = content.text.toLowerCase();
	const category = words.includes("agent")
		? "AI 工具"
		: words.includes("github") || content.sourceType === "github"
			? "开源项目"
			: content.sourceType === "bilibili" || content.sourceType === "video"
				? "视频内容"
				: "产品";
	const excerpt = content.text.slice(0, 360);
	return {
		title: content.title,
		summary: excerpt ? `暂未生成中文摘要，以下为原文摘录：${excerpt}` : "已收录，等待后续补充摘要。",
		category,
		tags: [SOURCE_TYPE_LABELS[content.sourceType], category].filter(Boolean),
		useCases: [],
		keyPoints: [],
	};
}

function arrayOfStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item)).filter(Boolean);
}

function normalizeIntent(value: any, text: string, urls: string[]): MessageIntent {
	const heuristic = heuristicIntent(text, urls);
	const intent = VALID_INTENTS.has(value?.intent) ? value.intent : heuristic.intent;
	return {
		intent,
		query: typeof value?.query === "string" && value.query.trim() ? value.query.trim() : heuristic.query,
		reason: typeof value?.reason === "string" && value.reason.trim() ? value.reason.trim() : heuristic.reason,
	};
}

function normalizeAgentPlan(value: any, text: string, urls: string[]): AgentPlan {
	const heuristic = heuristicAgentPlan(text, urls);
	const action = VALID_AGENT_ACTIONS.has(value?.action) ? value.action : heuristic.action;
	return {
		action,
		query: typeof value?.query === "string" && value.query.trim() ? value.query.trim() : heuristic.query,
		reason: typeof value?.reason === "string" && value.reason.trim() ? value.reason.trim() : heuristic.reason,
		question:
			typeof value?.question === "string" && value.question.trim() ? value.question.trim() : heuristic.question,
	};
}

function heuristicAgentPlan(text: string, urls: string[]): AgentPlan {
	const intent = heuristicIntent(text, urls);
	const normalized = text.trim();
	if (
		/(文档|资料库|知识库|记录)/i.test(normalized) &&
		/(英文|英语|english|翻译|中文|改成中文|变成中文|汉化)/i.test(normalized)
	) {
		return { action: "translate_records", query: normalized, reason: "用户想把知识文档中的英文内容改成中文" };
	}
	return { action: intent.intent, query: intent.query, reason: intent.reason };
}

function heuristicIntent(text: string, urls: string[]): MessageIntent {
	const normalized = text.trim();
	const lower = normalized.toLowerCase();
	if (/^(help|帮助|怎么用|你能做什么|使用说明|说明)$/i.test(normalized) || lower.includes("how to use")) {
		return { intent: "help", query: normalized, reason: "用户在询问使用方式" };
	}
	if (/(删除|删掉|去掉|移除|清除|取消收录|不要收录|从资料库.*删|从知识库.*删|delete|remove|clear)/i.test(normalized)) {
		return { intent: "delete_records", query: normalized, reason: "用户想删除已收录资料" };
	}
	if (
		/(腾讯云|服务器|云主机|cvm|主机|机器|实例|负载|cpu|内存|磁盘|硬盘|网络|带宽|pm2|caddy|在线|状态|监控|health|uptime|server)/i.test(
			normalized,
		) &&
		!urls.length
	) {
		return { intent: "server_status", query: normalized, reason: "用户想查看服务器或腾讯云监控状态" };
	}
	if (
		/(最近|列出|列表|有哪些|所有|查看|浏览|展示|资料库|知识库|收录了|收藏了|show|list|recent|records)/i.test(
			normalized,
		) &&
		!/(推荐|比较|哪个好|适合|方案|recommend|compare)/i.test(normalized)
	) {
		return { intent: "list_records", query: normalized, reason: "用户想查看已收录资料" };
	}
	if (urls.length) {
		return { intent: "archive_links", query: normalized, reason: "消息中包含链接，默认按收录处理" };
	}
	return { intent: "ask_question", query: normalized, reason: "无链接消息默认按知识库问答处理" };
}
