import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { buildKnowledgeBlocks, type DocBlock } from "./doc.js";
import type { IncomingMessage, KnowledgeRecord } from "./types.js";

export type FeishuCard = Record<string, unknown>;

/** Feishu rejects oversized child batches, so long archives are appended in slices. */
const DOC_BLOCK_CHUNK = 40;

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
						[fields.createdAt]: record.createdAt,
					},
				}),
			},
		);
	}

	/**
	 * Rebuilds the whole doc from `records.json` so it can never drift from the store.
	 * Callers must not let a failure here abort archiving; the local store is the source
	 * of truth and the doc is a mirror.
	 */
	async syncKnowledgeDoc(records: KnowledgeRecord[]): Promise<void> {
		const documentId = this.config.feishu.docId;
		if (!documentId || !this.config.feishu.appId) return;
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
		const body = await this.docApi(
			"GET",
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children?page_size=500`,
		);
		const items = body.data?.items;
		return Array.isArray(items) ? items.length : 0;
	}

	private async appendDocumentBlocks(documentId: string, children: DocBlock[]): Promise<void> {
		await this.docApi(
			"POST",
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
			{ children },
		);
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

function parseMessageText(content: string | undefined) {
	if (!content) return "";
	try {
		const parsed = JSON.parse(content);
		return parsed.text ?? parsed.content ?? "";
	} catch {
		return content;
	}
}

function safeEqual(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}
