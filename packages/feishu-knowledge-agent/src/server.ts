import { createServer } from "node:http";
import {
	analyzeForArchive,
	answerQuestion,
	planAgentAction,
	planRequirementPoints,
	translateRecordToChinese,
	translateTextToChinese,
} from "./analyzer.js";
import type { Config } from "./config.js";
import { answerDecisionHistory, type DecisionProgress, runDecisionAgent } from "./decisionAgent.js";
import { DecisionStore } from "./decisionStore.js";
import { extractContent } from "./extractors.js";
import { type FeishuCard, FeishuClient, parseFeishuEvent, verifyFeishuSignature } from "./feishu.js";
import { collectServerStatus, renderServerStatusReport } from "./serverStatus.js";
import { KnowledgeStore } from "./store.js";
import type {
	DecisionConditionStatus,
	DecisionRecord,
	FeishuDocumentTextBlock,
	KnowledgeRecord,
	Recommendation,
	RequirementPoint,
} from "./types.js";
import { readableSharer } from "./types.js";
import { extractUrls } from "./url.js";

type ProgressState = "pending" | "active" | "done";

interface ProgressStep {
	label: string;
	state: ProgressState;
}

interface ProgressCardRef {
	messageId?: string;
}

interface PendingClarification {
	/** The message that triggered the question, so the answer can be merged back into it. */
	originalText: string;
	question: string;
	expiresAt: number;
}

interface ScheduledArchiveReminder {
	id: string;
	records: KnowledgeRecord[];
	sourceChatId: string;
	targetChatId: string;
	senderId: string;
	createdAt: number;
	sendAt: number;
	cancelUntil: number;
	timer: ReturnType<typeof setTimeout>;
}

interface RecentDecisionContext {
	question: string;
	decisionId: string;
	expiresAt: number;
}

/**
 * Asking a clarifying question is useless without somewhere to keep it: each Feishu
 * event was handled independently, so the answer arrived with no idea what it
 * answered, and Mark asked again. Held in memory because a pending question is only
 * useful for minutes; a restart dropping it costs one repeated question.
 */
const pendingClarifications = new Map<string, PendingClarification>();
const CLARIFICATION_TTL_MS = 30 * 60 * 1000;
const scheduledArchiveReminders = new Map<string, ScheduledArchiveReminder>();
const recentDecisionContexts = new Map<string, RecentDecisionContext>();
const DECISION_CONTEXT_TTL_MS = 60 * 60 * 1000;

function takePendingClarification(chatId: string): PendingClarification | undefined {
	const pending = pendingClarifications.get(chatId);
	if (!pending) return undefined;
	pendingClarifications.delete(chatId);
	return pending.expiresAt > Date.now() ? pending : undefined;
}

function rememberClarification(chatId: string, originalText: string, question: string) {
	pendingClarifications.set(chatId, {
		originalText,
		question,
		expiresAt: Date.now() + CLARIFICATION_TTL_MS,
	});
	// Stale entries for other chats would otherwise accumulate for the process lifetime.
	for (const [key, value] of pendingClarifications) {
		if (value.expiresAt <= Date.now()) pendingClarifications.delete(key);
	}
}

function rememberDecisionContext(chatId: string, decision: DecisionRecord) {
	recentDecisionContexts.set(chatId, {
		question: decision.question,
		decisionId: decision.id,
		expiresAt: Date.now() + DECISION_CONTEXT_TTL_MS,
	});
	for (const [key, value] of recentDecisionContexts) {
		if (value.expiresAt <= Date.now()) recentDecisionContexts.delete(key);
	}
}

function decisionFollowupContext(chatId: string, text: string) {
	if (!/(调整条件|继续深挖|深入一下|换一批|换些方案|再找找)/i.test(text)) return undefined;
	const context = recentDecisionContexts.get(chatId);
	if (!context || context.expiresAt <= Date.now()) {
		recentDecisionContexts.delete(chatId);
		return undefined;
	}
	return context;
}

export function startServer(config: Config) {
	const store = new KnowledgeStore(config);
	const decisionStore = new DecisionStore(config);
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
						decisionStore,
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
	decisionStore: DecisionStore,
	feishu: FeishuClient,
	config: Config,
) {
	const progress: ProgressCardRef = {};
	const incomingText = typeof text === "string" ? text : String(text ?? "");
	if (isArchiveReminderCancelText(incomingText)) {
		await cancelLatestArchiveReminder(chatId, senderId, feishu);
		return;
	}
	// A reply to a clarifying question carries no context on its own ("技术方案的建议"),
	// so it is folded back into the request that prompted the question.
	const pending = takePendingClarification(chatId);
	const decisionFollowup = pending ? undefined : decisionFollowupContext(chatId, incomingText);
	const messageText = pending
		? `${pending.originalText}\n\n（我问了「${pending.question}」，用户补充：${incomingText}）`
		: decisionFollowup
			? `${decisionFollowup.question}\n\n（基于上一轮决策 ${decisionFollowup.decisionId}，用户继续要求：${incomingText}）`
			: incomingText;
	if (pending) console.info(`Merged clarification answer into the original request: chat=${chatId}`);
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

		// Clarifying twice in a row is the failure the user sees: they answer, and Mark
		// asks again. One question is the budget; after that, act on what we have.
		if (agentPlan.action === "clarify" && !pending) {
			const question = agentPlan.question || "你想让我具体处理哪一条资料？可以发标题关键词或原链接给我。";
			rememberClarification(chatId, incomingText, question);
			await finishProgressCard(feishu, chatId, progress, "需要确认一下", question, "yellow");
			return;
		}
		if (agentPlan.action === "clarify") {
			console.info("Planner asked to clarify again after an answer; answering with what we have instead");
			agentPlan.action = "ask_question";
			agentPlan.query = agentPlan.query || messageText;
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
			// The archive is shared, so one person must not be able to remove another's
			// entry. Records archived before ownership was tracked have no owner to
			// compare against and stay deletable, otherwise they could never be cleaned up.
			const ownDeletable = candidates.filter((record) => !record.sharerId || record.sharerId === senderId);
			const blocked = candidates.filter((record) => record.sharerId && record.sharerId !== senderId);
			if (!ownDeletable.length) {
				await finishProgressCard(
					feishu,
					chatId,
					progress,
					"这些资料不是你收录的",
					`为了避免误删别人的资料，Mark 只允许删除你自己收录的内容。\n\n${renderOwnershipBlocked(blocked)}\n\n需要删除的话，请让收录的人自己操作。`,
					"yellow",
				);
				return;
			}
			await updateProgressCard(feishu, progress, "Mark 正在更新资料库", [
				{ label: "理解消息", state: "done" },
				{ label: `找到 ${ownDeletable.length} 条可删资料`, state: "done" },
				{ label: "删除并同步文档", state: "active" },
			]);
			const deleted = await store.deleteByIds(ownDeletable.map((record) => record.id));
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				"已删除资料",
				`${renderDeleteReply(deleted, config)}${
					blocked.length
						? `\n\n另有 ${blocked.length} 条不是你收录的，已跳过：\n${renderOwnershipBlocked(blocked)}`
						: ""
				}`,
				"green",
			);
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

		if (agentPlan.action === "query_decisions") {
			await updateProgressCard(feishu, progress, "Mark 正在查找历史决策", [
				{ label: "理解消息", state: "done" },
				{ label: "检索决策中心", state: "active" },
				{ label: "整理当时依据", state: "pending" },
			]);
			const decisions = await decisionStore.search(agentPlan.query || messageText, 5);
			const answer = await answerDecisionHistory(agentPlan.query || messageText, decisions, config);
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				decisions.length ? "决策复盘" : "没有找到相关决策",
				appendDecisionDocLink(answer, config),
				decisions.length ? "purple" : "yellow",
			);
			return;
		}

		if (agentPlan.action === "make_decision") {
			const question = agentPlan.query || messageText;
			const requester = await resolveSharerDisplayName(feishu, senderId);
			const outcome = await runDecisionAgent(
				question,
				requester || readableSharer(senderId),
				senderId,
				store,
				config,
				{
					allowClarification: !pending,
					onProgress: async (decisionProgress) => {
						await updateProgressCard(
							feishu,
							progress,
							decisionProgressTitle(decisionProgress),
							decisionProgressSteps(decisionProgress),
						);
					},
				},
			);
			if (outcome.kind === "clarification") {
				rememberClarification(chatId, incomingText, outcome.question);
				await finishProgressCard(feishu, chatId, progress, "需要确认一个关键条件", outcome.question, "yellow");
				return;
			}

			await updateProgressCard(feishu, progress, "Mark 正在保存决策", [
				{ label: "理解目标和条件", state: "done" },
				{ label: "检索内部和外部证据", state: "done" },
				{ label: "比较候选方案", state: "done" },
				{ label: "写入决策中心", state: "active" },
			]);
			await decisionStore.save(outcome.decision);
			rememberDecisionContext(chatId, outcome.decision);
			if (decisionDocUrl(config)) {
				try {
					await feishu.syncDecisionDoc(await decisionStore.list());
				} catch (error) {
					console.error("Failed to sync Feishu decision doc", error);
					outcome.warnings.push(`决策已保存，但飞书决策中心同步失败：${summarizeFeishuError(error)}`);
				}
			} else {
				outcome.warnings.push("决策已保存到本地，尚未配置飞书决策中心文档。");
			}
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				"决策建议",
				renderDecisionReply(outcome.decision, outcome.warnings, config),
				"purple",
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
					sharerId: senderId,
					createdAt: new Date().toISOString(),
					rawText: content.text,
				};
				await store.save(record);
				await feishu.addBitableRecord(record);
				records.push(record);
			}
			const reminderNote = scheduleArchiveReminder(feishu, records, chatId, senderId, config);
			await finishProgressCard(
				feishu,
				chatId,
				progress,
				"收录完成",
				appendArchiveReminderNote(renderArchiveReply(records, config), reminderNote),
				"green",
			);
			// The local store is the source of truth; a doc sync failure must not make a
			// successful archive look failed, so it runs after the card and only logs.
			void addRecordsToKnowledgeDoc(feishu, store, records).catch((error) =>
				console.error("Failed to sync Feishu knowledge doc", error),
			);
			return;
		}

		const question = agentPlan.query || messageText;
		await updateProgressCard(feishu, progress, "Mark 正在拆解需求", [
			{ label: "理解消息", state: "done" },
			{ label: "拆解能力点", state: "active" },
			{ label: "逐点检索", state: "pending" },
			{ label: "生成方案", state: "pending" },
		]);
		const requirementPoints = await planRequirementPoints(question, config);
		// Each point is searched on its own so a broad point cannot crowd a narrow one
		// out of a single ranked list.
		const searched: Array<{ point: RequirementPoint; records: KnowledgeRecord[] }> = [];
		for (const [index, point] of requirementPoints.entries()) {
			await updateProgressCard(feishu, progress, `Mark 正在检索：${point.need}`, [
				{ label: "理解消息", state: "done" },
				{ label: `拆解出 ${requirementPoints.length} 个能力点`, state: "done" },
				{ label: `逐点检索 ${index + 1}/${requirementPoints.length}`, state: "active" },
				{ label: "生成方案", state: "pending" },
			]);
			searched.push({ point, records: await store.search(point.keywords || question, 5) });
		}
		const covered = searched.filter((entry) => entry.records.length).length;
		await updateProgressCard(feishu, progress, "Mark 正在生成方案", [
			{ label: "理解消息", state: "done" },
			{ label: `拆解出 ${requirementPoints.length} 个能力点`, state: "done" },
			{ label: `${covered}/${requirementPoints.length} 个点找到资料`, state: "done" },
			{ label: "生成方案", state: "active" },
		]);
		const recommendation = await answerQuestion(question, searched, config);
		await finishProgressCard(
			feishu,
			chatId,
			progress,
			requirementPoints.length > 1 ? "方案建议" : "推荐结果",
			renderRecommendationReply(recommendation),
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

/**
 * Adds each new record to its category section. Falls back to a full rebuild when the
 * document is not in a shape the incremental path can edit — an empty document, a
 * hand-edited one, or a re-archived link whose old entry has to be replaced.
 */
async function addRecordsToKnowledgeDoc(feishu: FeishuClient, store: KnowledgeStore, records: KnowledgeRecord[]) {
	for (const record of records) {
		const total = (await store.list()).length;
		const inserted = await feishu.insertRecordIntoDoc(record, total).catch((error) => {
			console.warn("Incremental Feishu doc insert failed, rebuilding instead", error);
			return false;
		});
		if (!inserted) {
			await feishu.syncKnowledgeDoc(await store.list());
			return;
		}
	}
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

function scheduleArchiveReminder(
	feishu: FeishuClient,
	records: KnowledgeRecord[],
	sourceChatId: string,
	senderId: string,
	config: Config,
) {
	const targetChatId = config.feishu.archiveReminderChatId.trim();
	if (!targetChatId || !records.length) return "";
	if (config.feishu.archiveReminderSkipSourceChat && targetChatId === sourceChatId) return "";

	cleanupArchiveReminders();
	const now = Date.now();
	const delayMinutes = Math.max(0, config.feishu.archiveReminderDelayMinutes);
	const cancelWindowMinutes = Math.max(0, config.feishu.archiveReminderCancelWindowMinutes);
	const delayMs = delayMinutes * 60 * 1000;
	const cancelWindowMs = cancelWindowMinutes * 60 * 1000;
	const sendAt = now + Math.max(delayMs, cancelWindowMs);
	const cancelUntil = now + cancelWindowMs;
	const id = crypto.randomUUID();
	const timer = setTimeout(
		() => {
			void sendArchiveReminder(id, feishu, config).catch((error) =>
				console.error("Failed to send delayed archive reminder", error),
			);
		},
		Math.max(0, sendAt - now),
	);

	scheduledArchiveReminders.set(id, {
		id,
		records,
		sourceChatId,
		targetChatId,
		senderId,
		createdAt: now,
		sendAt,
		cancelUntil,
		timer,
	});

	const sendLabel = formatDuration(sendAt - now);
	if (!cancelWindowMs) {
		return `群提醒将在 ${sendLabel} 后发送到指定群。`;
	}
	return `群提醒将在 ${sendLabel} 后发送到指定群，${formatDuration(cancelWindowMs)}内回复「撤回」或「取消提醒」可以取消这次群提醒。`;
}

async function sendArchiveReminder(id: string, feishu: FeishuClient, config: Config) {
	const reminder = scheduledArchiveReminders.get(id);
	if (!reminder) return;
	scheduledArchiveReminders.delete(id);
	await feishu.sendCard(
		reminder.targetChatId,
		renderResultCard("收录完成", renderArchiveReply(reminder.records, config), "green"),
	);
	console.info(
		`Sent delayed archive reminder: records=${reminder.records.length} target=${reminder.targetChatId} source=${reminder.sourceChatId}`,
	);
}

async function cancelLatestArchiveReminder(chatId: string, senderId: string, feishu: FeishuClient) {
	cleanupArchiveReminders();
	const now = Date.now();
	const reminders = Array.from(scheduledArchiveReminders.values())
		.filter((reminder) => reminder.senderId === senderId)
		.sort((a, b) => b.createdAt - a.createdAt);

	const cancellable = reminders.find((reminder) => reminder.cancelUntil >= now);
	if (!cancellable) {
		const hasPending = reminders.some((reminder) => reminder.sendAt > now);
		await feishu.sendCard(
			chatId,
			renderResultCard(
				hasPending ? "撤回窗口已过" : "没有可撤回提醒",
				hasPending
					? "我找到了你最近的待发送群提醒，但它已经过了撤回窗口。需要从资料库删除的话，可以发“删除 + 原链接”。"
					: "我没有找到你在撤回窗口内的待发送群提醒。收录链接后，请在提示的时间内回复「撤回」或「取消提醒」。",
				"yellow",
			),
		);
		return;
	}

	clearTimeout(cancellable.timer);
	scheduledArchiveReminders.delete(cancellable.id);
	await feishu.sendCard(
		chatId,
		renderResultCard("已撤回群提醒", renderArchiveReminderCancelReply(cancellable.records), "green"),
	);
	console.info(`Canceled delayed archive reminder: records=${cancellable.records.length} sender=${senderId}`);
}

function cleanupArchiveReminders() {
	const now = Date.now();
	for (const [id, reminder] of scheduledArchiveReminders) {
		if (reminder.sendAt + 10 * 60 * 1000 < now) {
			clearTimeout(reminder.timer);
			scheduledArchiveReminders.delete(id);
		}
	}
}

function isArchiveReminderCancelText(text: string) {
	return /^(撤回|取消|取消提醒|撤回提醒|别发群里|不要发群里|不要提醒|cancel)$/i.test(text.trim());
}

function appendArchiveReminderNote(body: string, reminderNote: string) {
	return reminderNote ? `${body}\n\n${reminderNote}` : body;
}

function renderArchiveReminderCancelReply(records: KnowledgeRecord[]) {
	const titles = records.map((record, index) => `${index + 1}. ${record.title}`).join("\n");
	return `已取消这次收录的群提醒，不会再发到指定群。\n\n${titles}\n\n资料仍然保留在资料库里；如果这个链接本身也收错了，可以继续发“删除 + 原链接”。`;
}

function formatDuration(ms: number) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds} 秒`;
	const minutes = Math.ceil(totalSeconds / 60);
	return `${minutes} 分钟`;
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
	const body = records.map((record, index) => `${index + 1}. ${record.title}\n链接：${record.url}`).join("\n\n");
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

function decisionDocUrl(config: Config) {
	return (
		config.feishu.decisionDocUrl ||
		(config.feishu.decisionDocId ? `https://feishu.cn/docx/${config.feishu.decisionDocId}` : "")
	);
}

function appendDecisionDocLink(text: string, config: Config) {
	const url = decisionDocUrl(config);
	return url ? `${text}\n\n决策中心：${url}` : text;
}

function decisionProgressTitle(progress: DecisionProgress) {
	return {
		planning: "Mark 正在理解决策目标",
		knowledge_search: "Mark 正在检索团队资料",
		web_search: "Mark 正在联网补充资料",
		reading_sources: "Mark 正在阅读来源",
		comparing: "Mark 正在比较候选方案",
		saving: "Mark 正在保存决策",
	}[progress.stage];
}

function decisionProgressSteps(progress: DecisionProgress): ProgressStep[] {
	const stages: Array<{ stage: DecisionProgress["stage"]; label: string }> = [
		{ stage: "planning", label: "理解目标和条件" },
		{ stage: "knowledge_search", label: "检索团队资料" },
		{ stage: "web_search", label: "联网补充候选" },
		{ stage: "reading_sources", label: "阅读和验证来源" },
		{ stage: "comparing", label: "比较方案并形成建议" },
	];
	const current = stages.findIndex((item) => item.stage === progress.stage);
	return stages.map((item, index) => ({
		label:
			index === current && progress.detail ? `${item.label}：${truncateInline(progress.detail, 80)}` : item.label,
		state: index < current ? "done" : index === current ? "active" : "pending",
	}));
}

function renderDecisionReply(decision: DecisionRecord, warnings: string[], config: Config) {
	const conditionLabels: Record<DecisionConditionStatus, string> = {
		met: "满足",
		partial: "部分满足",
		not_met: "不满足",
		unknown: "未知",
	};
	const candidateSections = decision.candidates
		.map((candidate, index) => {
			const conditions = candidate.conditions
				.map(
					(condition) =>
						`   - ${condition.criterion}：${conditionLabels[condition.status]}${condition.reason ? `，${condition.reason}` : ""}`,
				)
				.join("\n");
			const risks = candidate.risks.length ? `\n   风险：${candidate.risks.join("；")}` : "";
			return `${index + 1}. ${candidate.name}${candidate.url ? `\n   ${candidate.url}` : ""}\n   ${candidate.summary}${
				conditions ? `\n${conditions}` : ""
			}${risks}`;
		})
		.join("\n\n");
	const alternatives = decision.alternatives.length
		? `\n\n备选：\n${decision.alternatives.map((item) => `- ${item}`).join("\n")}`
		: "";
	const risks = decision.risks.length ? `\n\n主要风险：\n${decision.risks.map((item) => `- ${item}`).join("\n")}` : "";
	const unknowns = decision.unknowns.length
		? `\n\n待验证：\n${decision.unknowns.map((item) => `- ${item}`).join("\n")}`
		: "";
	const nextSteps = decision.nextSteps.length
		? `\n\n下一步：\n${decision.nextSteps.map((item) => `- ${item}`).join("\n")}`
		: "";
	const sources = decision.evidence.length
		? `\n\n证据来源：\n${decision.evidence
				.slice(0, 10)
				.map((item) => `[${item.id}] ${item.title}\n${item.url}`)
				.join("\n")}`
		: "\n\n证据来源：本次没有读取到可用来源。";
	const warning = warnings.length
		? `\n\n研究说明：\n${warnings
				.slice(0, 4)
				.map((item) => `- ${safeUserWarning(item)}`)
				.join("\n")}`
		: "";
	const interaction = "\n\n你可以继续说：“调整条件”、“继续深挖”或“为什么没选另一个”。";
	return appendDecisionDocLink(
		`建议：${decision.recommendation}\n\n理由：${decision.rationale}\n\n信心：${
			{
				high: "高",
				medium: "中",
				low: "低",
			}[decision.confidence]
		}${candidateSections ? `\n\n候选对比：\n\n${candidateSections}` : ""}${alternatives}${risks}${unknowns}${nextSteps}${sources}${warning}${interaction}`,
		config,
	);
}

function safeUserWarning(value: string) {
	return value
		.replace(/\b(?:sk|rk|pk|ghp|gho|github_pat)-?[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
		.replace(/\bAKID[A-Za-z0-9]{8,}\b/g, "[已隐藏]")
		.replace(/\b(?:cli|ou|oc)_[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
		.slice(0, 240);
}

/**
 * A single-point answer reads like the old flat recommendation; a multi-point one is
 * grouped so it is obvious which tool covers which part of the request, and which
 * parts the archive cannot cover yet.
 */
function renderOwnershipBlocked(records: KnowledgeRecord[]) {
	return records
		.map((record, index) => `${index + 1}. ${record.title}\n   收录人：${readableSharer(record.sharer)}`)
		.join("\n");
}

function renderRecommendationReply(recommendation: Recommendation) {
	const { answer, points } = recommendation;
	if (!points.length) return answer;

	if (points.length === 1) {
		const only = points[0];
		const picks = only.picks
			.map((pick, index) => `${index + 1}. ${pick.title}\n${pick.url}\n${pick.reason}`)
			.join("\n\n");
		const gap = only.gap ? `\n\n还缺：${only.gap}` : "";
		return picks ? `${answer}\n\n参考资料：\n${picks}${gap}` : `${answer}${gap}`;
	}

	const sections = points
		.map((point, index) => {
			const header = `${index + 1}. ${point.need}`;
			if (!point.picks.length) {
				return `${header}\n   暂无合适资料${point.gap ? `\n   缺口：${point.gap}` : ""}`;
			}
			const picks = point.picks
				.map((pick) => `   · ${pick.title}\n     ${pick.url}\n     ${pick.reason}`)
				.join("\n");
			return `${header}\n${picks}${point.gap ? `\n   缺口：${point.gap}` : ""}`;
		})
		.join("\n\n");

	const missing = points.filter((point) => !point.picks.length).length;
	const footer = missing ? `\n\n有 ${missing} 个点资料库还没覆盖，把相关链接发给我收录后可以再问一次。` : "";
	return `${answer}\n\n按能力点拆解：\n\n${sections}${footer}`;
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

function renderHelpReply(config: Config) {
	const docUrl = knowledgeDocUrl(config);
	return `我是 Mark，可以帮你沉淀产品和开源项目资料。

你可以这样发我：
1. 直接发链接：我会收录、摘要、分类和打标签。
2. 做决策：比如“预算每月 3000 元，帮我选一个社媒监测方案”。
3. 改资料：比如“文档里英文的内容帮我改成中文”。
4. 查资料：比如“列出最近收录的 10 个项目”。
5. 删资料：比如“删除 + 原链接”或“去掉某某项目”。
6. 复盘决策：比如“上次为什么选了那个方案”。
7. 查服务器：比如“看一下服务器状态”。

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
