import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { buildKnowledgeBlocks, type DocBlock } from "./doc.js";
import type { FeishuDocumentTextBlock, IncomingMessage, KnowledgeRecord } from "./types.js";

export type FeishuCard = Record<string, unknown>;

/** Feishu rejects oversized child batches, so long archives are appended in slices. */
const DOC_BLOCK_CHUNK = 40;
const TEXT_BLOCK_KEYS: Record<number, string> = {
	2: "text",
	3: "heading1",
	4: "heading2",
	5: "heading3",
	6: "heading4",
	7: "heading5",
	8: "heading6",
	9: "heading7",
	10: "heading8",
	11: "heading9",
	12: "bullet",
	13: "ordered",
	14: "code",
	15: "quote",
	19: "callout",
};

export function verifyFeishuSignature(config: Config, headers: Headers, rawBody: string): boolean {
	if (!config.feishu.encryptKey) return true;
	const timestamp = headers.get("x-lark-request-timestamp") ?? "";
	const nonce = headers.get("x-lark-request-nonce") ?? "";
	const signature = headers.get("x-lark-signature") ?? "";
	if (!timestamp || !nonce || !signature) return false;
	const expected = createHash("sha256")
		.update(timestamp + nonce + config.feishu.encryptKey + rawBody)
		.digest("hex");
	return safeEqual(expected, signature);
}

export function parseFeishuEvent(body: any, config: Config): { challenge?: string; message?: IncomingMessage } {
	if (body.type === "url_verification") {
		if (config.feishu.verificationToken && body.token !== config.feishu.verificationToken) {
			throw new Error("Invalid Feishu verification token");
		}
		return { challenge: body.challenge };
	}

	const eventType = body.header?.event_type ?? body.type;
	if (eventType !== "im.message.receive_v1") return {};
	if (config.feishu.verificationToken && body.header?.token && body.header.token !== config.feishu.verificationToken) {
		throw new Error("Invalid Feishu event token");
	}

	const event = body.event ?? {};
	const message = event.message ?? {};
	const content = parseMessageText(message.content);
	return {
		message: {
			messageId: message.message_id ?? body.header?.event_id ?? randomUUID(),
			chatId: message.chat_id,
			senderId: event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id ?? "",
			text: content,
			mentionsBot: Boolean(message.mentions?.length) || message.chat_type === "p2p",
		},
	};
}

export class FeishuClient {
	private token = "";
	private tokenExpiresAt = 0;
	private readonly userNameCache = new Map<string, string>();
	private readonly config: Config;

	constructor(config: Config) {
		this.config = config;
	}

	async sendText(openOrChatId: string, text: string): Promise<string | undefined> {
		if (!this.config.feishu.appId || !this.config.feishu.appSecret) return;
		const token = await this.getTenantToken();
		const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				receive_id: openOrChatId,
				msg_type: "text",
				content: JSON.stringify({ text }),
			}),
		});
		const body = (await response.json()) as any;
		if (!response.ok || body.code !== 0) {
			throw new Error(`Failed to send Feishu message: ${JSON.stringify(body)}`);
		}
		console.info(`Sent Feishu message: chat=${openOrChatId} message=${body.data?.message_id ?? "-"}`);
		return body.data?.message_id;
	}

	async sendCard(openOrChatId: string, card: FeishuCard): Promise<string | undefined> {
		if (!this.config.feishu.appId || !this.config.feishu.appSecret) return;
		const token = await this.getTenantToken();
		const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				receive_id: openOrChatId,
				msg_type: "interactive",
				content: JSON.stringify(card),
			}),
		});
		const body = (await response.json()) as any;
		if (!response.ok || body.code !== 0) {
			throw new Error(`Failed to send Feishu card: ${JSON.stringify(body)}`);
		}
		console.info(`Sent Feishu card: chat=${openOrChatId} message=${body.data?.message_id ?? "-"}`);
		return body.data?.message_id;
	}

	async patchCard(messageId: string, card: FeishuCard): Promise<void> {
		if (!this.config.feishu.appId || !this.config.feishu.appSecret) return;
		const token = await this.getTenantToken();
		const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				content: JSON.stringify(card),
			}),
		});
		const body = (await response.json()) as any;
		if (!response.ok || body.code !== 0) {
			throw new Error(`Failed to update Feishu card: ${JSON.stringify(body)}`);
		}
		console.info(`Updated Feishu card: message=${messageId}`);
	}

	async addBitableRecord(record: KnowledgeRecord): Promise<void> {
		const { bitableAppToken, bitableTableId, fields } = this.config.feishu;
		if (!bitableAppToken || !bitableTableId) return;
		const token = await this.getTenantToken();
		await fetch(
			`https://open.feishu.cn/open-apis/bitable/v1/apps/${bitableAppToken}/tables/${bitableTableId}/records`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify({
					fields: {
						[fields.title]: record.title,
						[fields.summary]: record.summary,
						[fields.category]: record.category,
						[fields.tags]: record.tags.join(", "),
						[fields.sourceUrl]: record.url,
						[fields.sourceType]: record.sourceType,
						[fields.useCases]: record.useCases.join("; "),
						[fields.sharer]: record.sharer || "-",
						[fields.createdAt]: record.createdAt,
					},
				}),
			},
		);
	}

	async resolveUserDisplayName(openId: string): Promise<string> {
		const userId = openId.trim();
		if (!userId) return "";
		const cached = this.userNameCache.get(userId);
		if (cached) return cached;
		if (!this.config.feishu.appId || !this.config.feishu.appSecret) return userId;
		const token = await this.getTenantToken();
		const params = new URLSearchParams({
			user_id_type: "open_id",
			department_id_type: "open_department_id",
		});
		const response = await fetch(
			`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(userId)}?${params.toString()}`,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
			},
		);
		const body = (await response.json()) as any;
		if (!response.ok || body.code !== 0) {
			throw new Error(`Feishu contact API failed: ${JSON.stringify(body).slice(0, 400)}`);
		}
		const user = body.data?.user;
		const name = [user?.name, user?.nickname, user?.en_name, user?.email].find(
			(value) => typeof value === "string" && value.trim(),
		);
		const displayName = String(name || userId).trim();
		this.userNameCache.set(userId, displayName);
		return displayName;
	}

	/**
	 * Rebuilds the whole doc from `records.json` so it can never drift from the store.
	 * Callers must not let a failure here abort archiving; the local store is the source
	 * of truth and the doc is a mirror.
	 */
	async syncKnowledgeDoc(records: KnowledgeRecord[]): Promise<void> {
		if (!this.config.feishu.appId) return;
		const documentId = await this.resolveConfiguredDocumentId();
		if (!documentId) return;
		await this.clearDocument(documentId);
		const blocks = buildKnowledgeBlocks(records);
		// Feishu caps how many children one call may add, and a large archive would
		// otherwise exceed it in a single request.
		for (let index = 0; index < blocks.length; index += DOC_BLOCK_CHUNK) {
			await this.appendDocumentBlocks(documentId, blocks.slice(index, index + DOC_BLOCK_CHUNK));
		}
		console.info(
			`Synced Feishu knowledge doc: document=${documentId} records=${records.length} blocks=${blocks.length}`,
		);
	}

	async createKnowledgeDoc(title: string, folderToken: string): Promise<string> {
		const body = await this.docApi("POST", "https://open.feishu.cn/open-apis/docx/v1/documents", {
			title,
			...(folderToken ? { folder_token: folderToken } : {}),
		});
		const documentId = body.data?.document?.document_id;
		if (!documentId) throw new Error(`Failed to create Feishu doc: ${JSON.stringify(body)}`);
		return documentId;
	}

	async listKnowledgeDocTextBlocks(): Promise<FeishuDocumentTextBlock[]> {
		const documentId = await this.resolveConfiguredDocumentId();
		if (!documentId) return [];
		const blocks: FeishuDocumentTextBlock[] = [];
		const visited = new Set<string>();
		await this.collectDocumentTextBlocks(documentId, documentId, blocks, visited);
		return blocks;
	}

	async updateKnowledgeDocTextBlock(block: FeishuDocumentTextBlock, text: string): Promise<void> {
		const documentId = await this.resolveConfiguredDocumentId();
		if (!documentId) return;
		await this.docApi(
			"PATCH",
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${block.blockId}`,
			{
				update_text_elements: {
					elements: [{ text_run: { content: text } }],
				},
			},
		);
	}

	private async resolveConfiguredDocumentId(): Promise<string> {
		if (this.config.feishu.docId) return this.config.feishu.docId;
		if (!this.config.feishu.docUrl) return "";
		const parsed = parseFeishuDocUrl(this.config.feishu.docUrl);
		if (!parsed) return this.config.feishu.docUrl;
		if (parsed.type === "docx") return parsed.token;
		const body = await this.docApi(
			"GET",
			`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,
		);
		const node = body.data?.node;
		if (!node?.obj_token) throw new Error(`Failed to resolve Feishu wiki node: ${JSON.stringify(body).slice(0, 400)}`);
		if (node.obj_type && node.obj_type !== "docx") {
			throw new Error(`Configured Feishu wiki node is ${node.obj_type}, but Mark can only sync docx pages.`);
		}
		return node.obj_token;
	}

	/**
	 * The batch_delete range is cleared and re-read until the document is empty, because
	 * whether `end_index` is inclusive is not something we could confirm from the docs.
	 */
	private async clearDocument(documentId: string): Promise<void> {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const count = await this.countDocumentChildren(documentId);
			if (count === 0) return;
			await this.docApi(
				"DELETE",
				`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_delete`,
				{ start_index: 0, end_index: count },
			);
		}
		throw new Error(`Could not clear Feishu doc ${documentId} after 20 passes`);
	}

	private async countDocumentChildren(documentId: string): Promise<number> {
		return (await this.listDocumentChildren(documentId, documentId)).length;
	}

	private async appendDocumentBlocks(documentId: string, children: DocBlock[]): Promise<void> {
		await this.docApi(
			"POST",
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
			{ children },
		);
	}

	private async collectDocumentTextBlocks(
		documentId: string,
		parentBlockId: string,
		blocks: FeishuDocumentTextBlock[],
		visited: Set<string>,
	): Promise<void> {
		if (visited.has(parentBlockId) || visited.size > 1000) return;
		visited.add(parentBlockId);
		const children = await this.listDocumentChildren(documentId, parentBlockId);
		for (const child of children) {
			const blockId = child.block_id;
			if (!blockId) continue;
			const text = extractBlockText(child);
			if (text) {
				blocks.push({ blockId, blockType: Number(child.block_type), text });
			}
			await this.collectDocumentTextBlocks(documentId, blockId, blocks, visited);
		}
	}

	private async listDocumentChildren(documentId: string, blockId: string): Promise<any[]> {
		const items: any[] = [];
		let pageToken = "";
		for (let page = 0; page < 20; page += 1) {
			const params = new URLSearchParams({ page_size: "500" });
			if (pageToken) params.set("page_token", pageToken);
			const body = await this.docApi(
				"GET",
				`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}/children?${params.toString()}`,
			);
			const pageItems = body.data?.items;
			if (Array.isArray(pageItems)) items.push(...pageItems);
			if (!body.data?.has_more || !body.data?.page_token) break;
			pageToken = body.data.page_token;
		}
		return items;
	}

	private async docApi(method: string, url: string, payload?: unknown): Promise<any> {
		const token = await this.getTenantToken();
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: payload === undefined ? undefined : JSON.stringify(payload),
		});
		const body = (await response.json()) as any;
		if (!response.ok || body.code !== 0) {
			throw new Error(`Feishu doc API ${method} ${url} failed: ${JSON.stringify(body).slice(0, 400)}`);
		}
		return body;
	}

	private async getTenantToken(): Promise<string> {
		if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
		const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				app_id: this.config.feishu.appId,
				app_secret: this.config.feishu.appSecret,
			}),
		});
		const body = (await response.json()) as any;
		if (!response.ok || !body.tenant_access_token)
			throw new Error(`Failed to get Feishu tenant token: ${JSON.stringify(body)}`);
		this.token = body.tenant_access_token;
		this.tokenExpiresAt = Date.now() + Math.max(60, Number(body.expire ?? 7200) - 120) * 1000;
		return this.token;
	}
}

function extractBlockText(block: any): string {
	const key = TEXT_BLOCK_KEYS[Number(block?.block_type)];
	const elements = key ? block?.[key]?.elements : undefined;
	if (!Array.isArray(elements)) return "";
	return elements
		.map((element) => element?.text_run?.content ?? element?.mention_user?.name ?? element?.mention_doc?.title ?? "")
		.join("")
		.trim();
}

function parseMessageText(content: string | undefined): string {
	if (!content) return "";
	try {
		const parsed = JSON.parse(content);
		return extractMessageText(parsed);
	} catch {
		return String(content);
	}
}

function extractMessageText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(extractMessageText).filter(Boolean).join("\n");
	if (typeof value !== "object") return "";

	const object = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["text", "title", "content", "href", "name"]) {
		const text = extractMessageText(object[key]);
		if (text) parts.push(text);
	}
	return [...new Set(parts)].join("\n").trim();
}

function safeEqual(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function parseFeishuDocUrl(input: string): { type: "docx" | "wiki"; token: string } | undefined {
	try {
		const url = new URL(input);
		const match = url.pathname.match(/\/(docx|wiki)\/([^/?#]+)/);
		if (!match) return undefined;
		return { type: match[1] as "docx" | "wiki", token: decodeURIComponent(match[2]) };
	} catch {
		const match = input.match(/\/(docx|wiki)\/([^/?#]+)/);
		if (!match) return undefined;
		return { type: match[1] as "docx" | "wiki", token: decodeURIComponent(match[2]) };
	}
}
