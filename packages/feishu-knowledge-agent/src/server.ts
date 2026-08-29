import { createServer } from "node:http";
import { analyzeForArchive, answerQuestion, classifyMessageIntent } from "./analyzer.js";
import type { Config } from "./config.js";
import { extractContent } from "./extractors.js";
import { type FeishuCard, FeishuClient, parseFeishuEvent, verifyFeishuSignature } from "./feishu.js";
import { collectServerStatus, renderServerStatusReport } from "./serverStatus.js";
import { KnowledgeStore } from "./store.js";
import type { KnowledgeRecord } from "./types.js";
import { extractUrls } from "./url.js";

type ProgressState = "pending" | "active" | "done";

interface ProgressStep {
	label: string;
	state: ProgressState;
}

interface ProgressCardRef {
	messageId?: string;
}

export function startServer(config: Config) {
	const store = new KnowledgeStore(config);
	const feishu = new FeishuClient(config);

	const server = createServer(async (request, response) => {
		try {
			if (request.method === "GET" && request.url === "/health") {
				return json(response, 200, { ok: true });
			}
			if (request.method === "POST" && request.url === "/feishu/events") {
				const rawBody = await readBody(request);
				if (!verifyFeishuSignature(config, new Headers(request.headers as Record<string, string>), rawBody)) {
					return json(response, 401, { error: "invalid signature" });
				}
				const body = JSON.parse(rawBody);
				const parsed = parseFeishuEvent(body, config);
				if (parsed.challenge) return json(response, 200, { challenge: parsed.challenge });
				if (parsed.message) {
					console.info(
						`Received Feishu message: chat=${parsed.message.chatId || "-"} textLength=${parsed.message.text.length}`,
					);
					void handleMessage(parsed.message.text, parsed.message.chatId, store, feishu, config).catch((error) => {
						console.error("Failed to handle Feishu message", error);
					});
				}
				return json(response, 200, {});
			}
			return json(response, 404, { error: "not found" });
		} catch (error) {
			return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});

	server.listen(config.port, () => {
		console.log(`Feishu knowledge agent listening on http://127.0.0.1:${config.port}`);
		console.log(`Event callback path: /feishu/events`);
	});
	return server;
}

async function handleMessage(
	text: string,
	chatId: string,
	store: KnowledgeStore,
	feishu: FeishuClient,
	config: Config,
) {
	const progress = await startProgressCard(feishu, chatId);
	const urls = extractUrls(text);
	try {
		await updateProgressCard(feishu, progress, "Mark 正在理解你的需求", [
			{ label: "理解消息", state: "active" },
			{ label: "处理任务", state: "pending" },
			{ label: "整理结果", state: "pending" },
		]);
		const messageIntent = await classifyMessageIntent(text, urls, config);
		console.info(`Classified Feishu message intent: ${messageIntent.intent}`);

		if (messageIntent.intent === "help") {
			await finishProgressCard(feishu, chatId, progress, "Mark 使用说明", renderHelpReply(config), "turquoise");
			return;
		}

		if (messageIntent.intent === "list_records") {
			await updateProgressCard(feishu, progress, "Mark 正在检索资料库", [
				{ label: "理解消息", state: "done" },
				{ label: "检索资料", state: "active" },
				{ label: "整理结果", state: "pending" },
			]);
			const records = await pickRecordsForList(store, messageIntent.query);
			await finishProgressCard(feishu, chatId, progress, "资料列表", renderListReply(records, config), "blue");
			return;
		}

		if (messageIntent.intent === "server_status") {
			await updateProgressCard(feishu, progress, "Mark 正在读取服务器状态", [
				{ label: "理解消息", state: "done" },
				{ label: "读取本机状态", state: "active" },
				{ label: "读取腾讯云监控", state: "pending" },
			]);
			const statusReport = await collectServerStatus(config, messageIntent.query);
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				"服务器状态",
				renderServerStatusReport(statusReport),
				"green",
			);
			return;
		}

		if (messageIntent.intent === "archive_links") {
			if (!urls.length) {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"等待链接",
					"我可以帮你收录链接。把推文、文章、GitHub 项目或 B 站视频链接发给我就行。",
					"yellow",
				);
				return;
			}
			await updateProgressCard(feishu, progress, "Mark 正在读取链接", [
				{ label: "理解消息", state: "done" },
				{ label: `读取 ${urls.length} 个链接`, state: "active" },
				{ label: "分析并收录", state: "pending" },
			]);
			const records: KnowledgeRecord[] = [];
			for (const [index, url] of urls.entries()) {
				await updateProgressCard(feishu, progress, `Mark 正在分析链接 ${index + 1}/${urls.length}`, [
					{ label: "理解消息", state: "done" },
					{ label: "读取链接", state: "done" },
					{ label: `分析并收录 ${index + 1}/${urls.length}`, state: "active" },
				]);
				const content = await extractContent(url, config);
				const analyzed = await analyzeForArchive(content, config);
				const record: KnowledgeRecord = {
					id: crypto.randomUUID(),
					...analyzed,
					createdAt: new Date().toISOString(),
					rawText: content.text,
				};
				await store.save(record);
				await feishu.addBitableRecord(record);
				records.push(record);
			}
			await finishProgressCard(feishu, chatId, progress, "收录完成", renderArchiveReply(records, config), "green");
			// The local store is the source of truth; a doc sync failure must not make a
			// successful archive look failed, so it runs after the card and only logs.
			void feishu
				.syncKnowledgeDoc(await store.list())
				.catch((error) => console.error("Failed to sync Feishu knowledge doc", error));
			return;
		}

		await updateProgressCard(feishu, progress, "Mark 正在检索和分析", [
			{ label: "理解消息", state: "done" },
			{ label: "检索资料库", state: "active" },
			{ label: "生成建议", state: "pending" },
		]);
		const candidates = await store.search(messageIntent.query || text, 8);
		await updateProgressCard(feishu, progress, "Mark 正在生成推荐", [
			{ label: "理解消息", state: "done" },
			{ label: `找到 ${candidates.length} 条相关资料`, state: "done" },
			{ label: "生成建议", state: "active" },
		]);
		const recommendation = await answerQuestion(messageIntent.query || text, candidates, config);
		await finishProgressCard(
			feishu,
			chatId,
			progress,
			"推荐结果",
			renderRecommendationReply(recommendation.answer, recommendation.candidates),
			"purple",
		);
	} catch (error) {
		await finishProgressCard(
			feishu,
			chatId,
			progress,
			"处理失败",
			`这次处理没有成功：${error instanceof Error ? error.message : String(error)}`,
			"red",
		).catch((sendError) => console.error("Failed to send failure card", sendError));
		throw error;
	}
}

async function pickRecordsForList(store: KnowledgeStore, query: string) {
	const records = await store.list();
	if (!records.length) return [];
	if (/(最近|latest|recent|列表|所有|全部|收录|收藏)/i.test(query)) return records.slice(0, 10);
	const searched = await store.search(query, 10);
	return searched.length ? searched : records.slice(0, 10);
}

function renderArchiveReply(records: KnowledgeRecord[], config: Config) {
	const body = records
		.map(
			(record) => `已收录：${record.title}
分类：${record.category}
标签：${record.tags.join(", ") || "-"}
摘要：${record.summary}
原链接：${record.url}`,
		)
		.join("\n\n");
	const docUrl = knowledgeDocUrl(config);
	return docUrl ? `${body}\n\n资料库文档：${docUrl}` : body;
}

function knowledgeDocUrl(config: Config) {
	return config.feishu.docId ? `https://feishu.cn/docx/${config.feishu.docId}` : "";
}

function renderRecommendationReply(answer: string, candidates: Array<{ title: string; url: string; reason: string }>) {
	const sources = candidates
		.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.reason}`)
		.join("\n\n");
	return sources ? `${answer}\n\n参考资料：\n${sources}` : answer;
}

function renderListReply(records: KnowledgeRecord[], config: Config) {
	const docUrl = knowledgeDocUrl(config);
	const footer = docUrl ? `\n\n完整资料库：${docUrl}` : "";
	if (!records.length) {
		return `目前还没有收录资料。你可以先发一个推文、文章、GitHub 项目或 B 站视频链接给我。${footer}`;
	}
	return `最近/相关资料：\n\n${records
		.map(
			(record, index) => `${index + 1}. ${record.title}
分类：${record.category}
标签：${record.tags.join(", ") || "-"}
链接：${record.url}`,
		)
		.join("\n\n")}${footer}`;
}

function renderHelpReply(config: Config) {
	const docUrl = knowledgeDocUrl(config);
	return `我是 Mark，可以帮你沉淀产品和开源项目资料。

你可以这样发我：
1. 直接发链接：我会收录、摘要、分类和打标签。
2. 问推荐：比如“给我推荐一个做 B 站字幕提取的工具”。
3. 查资料：比如“列出最近收录的 10 个项目”。
4. 查服务器：比如“看一下服务器状态”。

支持的链接包括 GitHub、文章、X/Twitter 和 B 站视频。${
		docUrl ? `\n\n收录的资料会同步到这份文档，可以直接翻阅：\n${docUrl}` : ""
	}`;
}

async function startProgressCard(feishu: FeishuClient, chatId: string): Promise<ProgressCardRef> {
	const messageId = await feishu.sendCard(
		chatId,
		renderProgressCard("Mark 收到了", [
			{ label: "理解消息", state: "active" },
			{ label: "处理任务", state: "pending" },
			{ label: "整理结果", state: "pending" },
		]),
	);
	return { messageId };
}

async function updateProgressCard(
	feishu: FeishuClient,
	progress: ProgressCardRef,
	title: string,
	steps: ProgressStep[],
) {
	if (!progress.messageId) return;
	try {
		await feishu.patchCard(progress.messageId, renderProgressCard(title, steps));
	} catch (error) {
		console.warn("Failed to update Feishu progress card; falling back to final text reply", error);
		progress.messageId = undefined;
	}
}

async function finishProgressCard(
	feishu: FeishuClient,
	chatId: string,
	progress: ProgressCardRef,
	title: string,
	text: string,
	template: "blue" | "green" | "purple" | "red" | "turquoise" | "yellow",
) {
	const card = renderResultCard(title, text, template);
	if (progress.messageId) {
		try {
			await feishu.patchCard(progress.messageId, card);
			return;
		} catch (error) {
			console.warn("Failed to finish Feishu progress card; sending final text reply", error);
			progress.messageId = undefined;
		}
	}
	await feishu.sendText(chatId, text);
}

function renderProgressCard(title: string, steps: ProgressStep[]): FeishuCard {
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: {
			template: "blue",
			title: { tag: "plain_text", content: title },
		},
		elements: [
			{
				tag: "div",
				text: { tag: "lark_md", content: steps.map(renderProgressStep).join("\n") },
			},
		],
	};
}

function renderResultCard(
	title: string,
	text: string,
	template: "blue" | "green" | "purple" | "red" | "turquoise" | "yellow",
): FeishuCard {
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: {
			template,
			title: { tag: "plain_text", content: title },
		},
		elements: [
			{
				tag: "div",
				text: { tag: "lark_md", content: truncateCardText(text) },
			},
		],
	};
}

function renderProgressStep(step: ProgressStep) {
	const mark = step.state === "done" ? "[x]" : step.state === "active" ? "[...]" : "[ ]";
	return `${mark} ${step.label}`;
}

function truncateCardText(text: string) {
	if (text.length <= 12000) return text;
	return `${text.slice(0, 12000)}\n\n内容较长，已先展示前半部分。`;
}

function readBody(request: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("end", () => resolve(data));
		request.on("error", reject);
	});
}

function json(response: any, status: number, body: unknown) {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}
