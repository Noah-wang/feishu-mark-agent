import { createServer } from "node:http";
import {
	analyzeForArchive,
	answerQuestion,
	planAgentAction,
	translateRecordToChinese,
	translateTextToChinese,
} from "./analyzer.js";
import type { Config } from "./config.js";
import { extractContent } from "./extractors.js";
import { type FeishuCard, FeishuClient, parseFeishuEvent, verifyFeishuSignature } from "./feishu.js";
import { collectServerStatus, renderServerStatusReport } from "./serverStatus.js";
import { KnowledgeStore } from "./store.js";
import type { FeishuDocumentTextBlock, KnowledgeRecord } from "./types.js";
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
					void handleMessage(
						parsed.message.text,
						parsed.message.chatId,
						parsed.message.senderId,
						store,
						feishu,
						config,
					).catch((error) => {
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
	senderId: string,
	store: KnowledgeStore,
	feishu: FeishuClient,
	config: Config,
) {
	const progress: ProgressCardRef = {};
	const messageText = typeof text === "string" ? text : String(text ?? "");
	try {
		Object.assign(progress, await startProgressCard(feishu, chatId));
		const urls = extractUrls(messageText);
		await updateProgressCard(feishu, progress, "Mark 正在理解你的需求", [
			{ label: "理解消息", state: "active" },
			{ label: "处理任务", state: "pending" },
			{ label: "整理结果", state: "pending" },
		]);
		const agentPlan = await planAgentAction(messageText, urls, config);
		console.info(`Planned Feishu agent action: ${agentPlan.action} reason=${agentPlan.reason}`);

		if (agentPlan.action === "clarify") {
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				"需要确认一下",
				agentPlan.question || "你想让我具体处理哪一条资料？可以发标题关键词或原链接给我。",
				"yellow",
			);
			return;
		}

		if (agentPlan.action === "help") {
			await finishProgressCard(feishu, chatId, progress, "Mark 使用说明", renderHelpReply(config), "turquoise");
			return;
		}

		if (agentPlan.action === "delete_records") {
			await updateProgressCard(feishu, progress, "Mark 正在查找要删除的资料", [
				{ label: "理解消息", state: "done" },
				{ label: "查找匹配资料", state: "active" },
				{ label: "更新资料库", state: "pending" },
			]);
			const candidates = await store.findForDeletion(agentPlan.query || messageText, urls, 8);
			if (!candidates.length) {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"没有找到可删除资料",
					"我没有在已收录资料里找到匹配项。你可以发“删除 + 原链接”，或者发更完整的标题关键词。",
					"yellow",
				);
				return;
			}
			if (candidates.length > 3 && !urls.length) {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"找到多条相似资料",
					`我找到了 ${candidates.length} 条可能相关的资料。为了避免误删，请发“删除 + 更完整标题”或直接发原链接。\n\n${renderDeletionCandidates(candidates)}`,
					"yellow",
				);
				return;
			}
			await updateProgressCard(feishu, progress, "Mark 正在更新资料库", [
				{ label: "理解消息", state: "done" },
				{ label: `找到 ${candidates.length} 条资料`, state: "done" },
				{ label: "删除并同步文档", state: "active" },
			]);
			const deleted = await store.deleteByIds(candidates.map((record) => record.id));
			await finishProgressCard(feishu, chatId, progress, "已删除资料", renderDeleteReply(deleted, config), "green");
			void feishu
				.syncKnowledgeDoc(await store.list())
				.catch((error) => console.error("Failed to sync Feishu knowledge doc after deletion", error));
			return;
		}

		if (agentPlan.action === "translate_records") {
			await updateProgressCard(feishu, progress, "Mark 正在读取飞书资料库文档", [
				{ label: "理解目标", state: "done" },
				{ label: "读取文档正文", state: "active" },
				{ label: "查找英文并改写", state: "pending" },
			]);
			const docTranslation = await translateEnglishInKnowledgeDoc(feishu, agentPlan.query || messageText, config);
			if (docTranslation.status === "updated") {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"已改飞书文档",
					renderDocTranslateReply(docTranslation.blocks, config),
					"green",
				);
				return;
			}
			if (docTranslation.status === "permission_error") {
				console.warn(`Could not translate Feishu document directly: ${docTranslation.message}`);
			}

			await updateProgressCard(feishu, progress, "Mark 正在检查本地资料里的英文内容", [
				{ label: "理解目标", state: "done" },
				{ label: docTranslation.status === "no_doc" ? "未配置飞书文档" : "飞书文档未发现英文块", state: "done" },
				{ label: "查找本地英文资料", state: "active" },
			]);
			const candidates = await pickRecordsForTranslation(store, agentPlan.query || messageText);
			if (!candidates.length) {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"没有找到明显英文资料",
					docTranslation.status === "no_english"
						? "我已经读了飞书资料库文档，也查了本地已收录资料，暂时没有发现明显需要翻译的英文条目。你可以把那一段直接发给我，或者给我更具体的标题。"
						: docTranslation.status === "permission_error"
							? `${docTranslation.message}\n\n我也查了本地已收录资料，没有找到明显需要翻译的英文条目。`
						: "我没有在已收录资料里找到明显需要翻译的英文条目。你可以把那一段直接发给我，或者发更具体的标题。",
					"yellow",
				);
				return;
			}
			const shouldTranslateAll = /(全部|所有|都|all)/i.test(agentPlan.query || messageText);
			if (candidates.length > 3 && !shouldTranslateAll) {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"找到多条英文资料",
					`我找到了 ${candidates.length} 条可能含英文的资料。为了避免乱改，请告诉我具体改哪一条，或者回复“把这些都改成中文”。\n\n${renderDeletionCandidates(candidates)}`,
					"yellow",
				);
				return;
			}
			const targets = shouldTranslateAll ? candidates.slice(0, 10) : candidates.slice(0, 3);
			await updateProgressCard(feishu, progress, "Mark 正在改写资料", [
				{ label: "理解目标", state: "done" },
				{ label: `找到 ${targets.length} 条资料`, state: "done" },
				{ label: "翻译成中文", state: "active" },
			]);
			const translated: KnowledgeRecord[] = [];
			for (const record of targets) {
				const updated = await translateRecordToChinese(record, agentPlan.query || messageText, config);
				await store.save(updated);
				translated.push(updated);
			}
			const syncError = await syncKnowledgeDocForUser(feishu, store);
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				syncError ? "已改写，文档同步需要权限" : "已改成中文",
				renderTranslateReply(translated, config, syncError),
				syncError ? "yellow" : "green",
			);
			return;
		}

		if (agentPlan.action === "list_records") {
			await updateProgressCard(feishu, progress, "Mark 正在检索资料库", [
				{ label: "理解消息", state: "done" },
				{ label: "检索资料", state: "active" },
				{ label: "整理结果", state: "pending" },
			]);
			const records = await pickRecordsForList(store, agentPlan.query);
			await finishProgressCard(feishu, chatId, progress, "资料列表", renderListReply(records, config), "blue");
			return;
		}

		if (agentPlan.action === "server_status") {
			await updateProgressCard(feishu, progress, "Mark 正在读取服务器状态", [
				{ label: "理解消息", state: "done" },
				{ label: "读取本机状态", state: "active" },
				{ label: "读取腾讯云监控", state: "pending" },
			]);
			const statusReport = await collectServerStatus(config, agentPlan.query);
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

		if (agentPlan.action === "archive_links") {
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
			const sharer = await resolveSharerDisplayName(feishu, senderId);
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
					sharer: sharer || senderId || "unknown",
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
		const candidates = await store.search(agentPlan.query || messageText, 8);
		await updateProgressCard(feishu, progress, "Mark 正在生成推荐", [
			{ label: "理解消息", state: "done" },
			{ label: `找到 ${candidates.length} 条相关资料`, state: "done" },
			{ label: "生成建议", state: "active" },
		]);
		const recommendation = await answerQuestion(agentPlan.query || messageText, candidates, config);
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

type DocTranslationResult =
	| { status: "updated"; blocks: Array<{ before: string; after: string }> }
	| { status: "no_english" | "no_doc"; message: string }
	| { status: "permission_error"; message: string };

async function translateEnglishInKnowledgeDoc(
	feishu: FeishuClient,
	request: string,
	config: Config,
): Promise<DocTranslationResult> {
	let blocks: FeishuDocumentTextBlock[];
	try {
		blocks = await feishu.listKnowledgeDocTextBlocks();
	} catch (error) {
		console.error("Failed to read Feishu knowledge doc for translation", error);
		return { status: "permission_error", message: summarizeFeishuError(error) };
	}
	if (!blocks.length) {
		return { status: "no_doc", message: "还没有配置或读取到飞书资料库文档。" };
	}
	const candidates = blocks
		.map((block) => ({ block, score: docEnglishScore(block.text) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, /(全部|所有|都|all)/i.test(request) ? 12 : 5);
	if (!candidates.length) {
		return { status: "no_english", message: "飞书资料库文档里没有发现明显英文段落。" };
	}

	const updated: Array<{ before: string; after: string }> = [];
	for (const { block } of candidates) {
		const translated = await translateTextToChinese(block.text, request, config);
		if (!translated || normalizeComparableText(translated) === normalizeComparableText(block.text)) continue;
		await feishu.updateKnowledgeDocTextBlock(block, translated);
		updated.push({ before: block.text, after: translated });
		await delay(400);
	}
	if (!updated.length) {
		return { status: "no_english", message: "我找到了疑似英文块，但改写后没有产生有效变化。" };
	}
	return { status: "updated", blocks: updated };
}

async function resolveSharerDisplayName(feishu: FeishuClient, senderId: string) {
	if (!senderId) return "";
	try {
		return await feishu.resolveUserDisplayName(senderId);
	} catch (error) {
		console.warn("Failed to resolve Feishu sender display name", error);
		return readableSharer(senderId);
	}
}

async function pickRecordsForList(store: KnowledgeStore, query: string) {
	const records = await store.list();
	if (!records.length) return [];
	if (/(最近|latest|recent|列表|所有|全部|收录|收藏)/i.test(query)) return records.slice(0, 10);
	const searched = await store.search(query, 10);
	return searched.length ? searched : records.slice(0, 10);
}

async function pickRecordsForTranslation(store: KnowledgeStore, query: string) {
	const records = await store.list();
	if (!records.length) return [];
	const searched = await store.search(query, 10);
	const pool = searched.length ? searched : records;
	return pool
		.map((record) => ({ record, score: englishScore(record) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((item) => item.record)
		.slice(0, 10);
}

async function syncKnowledgeDocForUser(feishu: FeishuClient, store: KnowledgeStore) {
	try {
		await feishu.syncKnowledgeDoc(await store.list());
		return "";
	} catch (error) {
		console.error("Failed to sync Feishu knowledge doc after translation", error);
		return summarizeFeishuError(error);
	}
}

function englishScore(record: KnowledgeRecord) {
	const text = [
		record.title,
		record.summary,
		record.category,
		record.tags.join(" "),
		record.useCases.join(" "),
		record.keyPoints.join(" "),
	].join(" ");
	const latinWords = text.match(/[a-z][a-z-]{3,}/gi) ?? [];
	const cjkChars = text.match(/[\u4e00-\u9fff]/g) ?? [];
	const meaningfulWords = latinWords.filter((word) => !ENGLISH_ALLOWED_WORDS.has(word.toLowerCase()));
	if (meaningfulWords.length >= 8) return meaningfulWords.length * 2;
	if (meaningfulWords.length >= 3 && cjkChars.length < 20) return meaningfulWords.length;
	return 0;
}

function docEnglishScore(text: string) {
	const trimmed = text.trim();
	if (trimmed.length < 24 || isUrlLikeText(trimmed)) return 0;
	const latinWords = trimmed.match(/[a-z][a-z-]{3,}/gi) ?? [];
	const cjkChars = trimmed.match(/[\u4e00-\u9fff]/g) ?? [];
	const meaningfulWords = latinWords.filter((word) => !ENGLISH_ALLOWED_WORDS.has(word.toLowerCase()));
	if (meaningfulWords.length >= 8) return meaningfulWords.length * 2;
	if (meaningfulWords.length >= 4 && cjkChars.length < 20) return meaningfulWords.length;
	return 0;
}

function isUrlLikeText(text: string) {
	if (/^https?:\/\/\S+$/i.test(text)) return true;
	if (/^[\w./:@?=&%#-]+$/.test(text) && /[./]/.test(text)) return true;
	return false;
}

function normalizeComparableText(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENGLISH_ALLOWED_WORDS = new Set([
	"github",
	"openai",
	"api",
	"sdk",
	"llm",
	"agent",
	"mark",
	"http",
	"https",
	"www",
	"com",
	"run",
]);

function renderArchiveReply(records: KnowledgeRecord[], config: Config) {
	const body = records
		.map(
			(record) => `已收录：${record.title}
分类：${record.category}
标签：${record.tags.join(", ") || "-"}
摘要：${record.summary}
分享者：${readableSharer(record.sharer)}
原链接：${record.url}`,
		)
		.join("\n\n");
	const docUrl = knowledgeDocUrl(config);
	return docUrl ? `${body}\n\n资料库文档：${docUrl}` : body;
}

function renderTranslateReply(records: KnowledgeRecord[], config: Config, syncError: string) {
	const body = records
		.map((record, index) => `${index + 1}. ${record.title}\n链接：${record.url}`)
		.join("\n\n");
	const docUrl = knowledgeDocUrl(config);
	const docLine = docUrl ? `\n\n资料库文档：${docUrl}` : "";
	const syncLine = syncError ? `\n\n不过飞书文档同步还没成功：${syncError}` : "";
	return `我已把这些资料的标题、摘要、分类、标签和要点改成中文：\n\n${body}${docLine}${syncLine}`;
}

function renderDocTranslateReply(blocks: Array<{ before: string; after: string }>, config: Config) {
	const docUrl = knowledgeDocUrl(config);
	const examples = blocks
		.slice(0, 3)
		.map((block, index) => `${index + 1}. ${truncateInline(block.before, 80)}\n→ ${truncateInline(block.after, 120)}`)
		.join("\n\n");
	return `我读了飞书资料库文档，并把 ${blocks.length} 段明显英文内容改成了中文。${
		docUrl ? `\n\n资料库文档：${docUrl}` : ""
	}${examples ? `\n\n改动预览：\n${examples}` : ""}`;
}

function truncateInline(text: string, length: number) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > length ? `${collapsed.slice(0, length - 1)}…` : collapsed;
}

function summarizeFeishuError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (/wiki:node:read|wiki:wiki|Access denied|99991672/i.test(message)) {
		return "飞书应用还缺 Wiki 读取权限，需要在开放平台开通 wiki:node:read 后再同步。";
	}
	if (/docx|document|permission|Access denied/i.test(message)) {
		return "飞书应用还缺文档读写权限，或这篇 Wiki 没有把应用加为协作者。";
	}
	return message.slice(0, 300);
}

function knowledgeDocUrl(config: Config) {
	return config.feishu.docUrl || (config.feishu.docId ? `https://feishu.cn/docx/${config.feishu.docId}` : "");
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
分享者：${readableSharer(record.sharer)}
链接：${record.url}`,
		)
		.join("\n\n")}${footer}`;
}

function renderDeleteReply(records: KnowledgeRecord[], config: Config) {
	const body = records.length
		? `已从资料库删除：\n\n${records
				.map((record, index) => `${index + 1}. ${record.title}\n链接：${record.url}`)
				.join("\n\n")}`
		: "没有删除任何资料。";
	const docUrl = knowledgeDocUrl(config);
	return docUrl ? `${body}\n\n资料库文档会自动同步：${docUrl}` : body;
}

function renderDeletionCandidates(records: KnowledgeRecord[]) {
	return records
		.slice(0, 8)
		.map((record, index) => `${index + 1}. ${record.title}\n${record.url}`)
		.join("\n\n");
}

function readableSharer(sharer: string) {
	const value = sharer.trim();
	if (!value || value === "unknown" || /^ou_[a-z0-9]+$/i.test(value)) return "飞书用户";
	return value;
}

function renderHelpReply(config: Config) {
	const docUrl = knowledgeDocUrl(config);
	return `我是 Mark，可以帮你沉淀产品和开源项目资料。

你可以这样发我：
1. 直接发链接：我会收录、摘要、分类和打标签。
2. 问推荐：比如“给我推荐一个做 B 站字幕提取的工具”。
3. 改资料：比如“文档里英文的内容帮我改成中文”。
4. 查资料：比如“列出最近收录的 10 个项目”。
5. 删资料：比如“删除 + 原链接”或“去掉某某项目”。
6. 查服务器：比如“看一下服务器状态”。

现在我会先规划要做什么，信息不够会追问。支持的链接包括 GitHub、文章、X/Twitter 和 B 站视频。${
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
