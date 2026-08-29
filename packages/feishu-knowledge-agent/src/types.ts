export type SourceType = "x" | "github" | "bilibili" | "article" | "video" | "unknown";

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
	x: "X 推文",
	github: "GitHub 项目",
	bilibili: "B 站视频",
	article: "文章",
	video: "视频",
	unknown: "其他",
};

export interface ExtractedContent {
	url: string;
	sourceType: SourceType;
	title: string;
	text: string;
	images: string[];
	metadata: Record<string, unknown>;
}

export interface KnowledgeRecord {
	id: string;
	url: string;
	sourceType: SourceType;
	title: string;
	summary: string;
	category: string;
	tags: string[];
	useCases: string[];
	keyPoints: string[];
	images: string[];
	metadata: Record<string, unknown>;
	/** Display label for the archive; a name once the contact scope is granted, otherwise an open_id. */
	sharer: string;
	/**
	 * The archiver's open_id. Kept separate from `sharer` because that one holds a
	 * display name once contact permission exists, and a name cannot be compared
	 * against the sender of a delete request.
	 */
	sharerId: string;
	createdAt: string;
	rawText: string;
}

export interface FeishuDocumentTextBlock {
	blockId: string;
	blockType: number;
	text: string;
}

/**
 * One capability a request needs. "我要做个产品，要能读 B 站视频内容再自动整理" is
 * two of these, and each is searched separately so one point cannot crowd the
 * other out of a single ranked result list.
 */
export interface RequirementPoint {
	need: string;
	keywords: string;
}

export interface SolutionPoint {
	need: string;
	picks: Array<{
		title: string;
		url: string;
		reason: string;
	}>;
	/** What the archive lacks for this point. Empty when it is covered. */
	gap: string;
}

export interface Recommendation {
	answer: string;
	points: SolutionPoint[];
}

export type MessageIntentName =
	| "archive_links"
	| "ask_question"
	| "list_records"
	| "delete_records"
	| "server_status"
	| "help";

export type AgentActionName = MessageIntentName | "translate_records" | "clarify";

export interface MessageIntent {
	intent: MessageIntentName;
	query: string;
	reason: string;
}

export interface AgentPlan {
	action: AgentActionName;
	query: string;
	reason: string;
	question?: string;
}

export interface IncomingMessage {
	messageId: string;
	chatId: string;
	senderId: string;
	text: string;
	mentionsBot: boolean;
}

/**
 * Feishu only gives an open_id until the contact scope is granted, so fall back to a
 * generic label rather than showing a raw `ou_...` identifier in the archive.
 */
export function readableSharer(sharer: string | undefined): string {
	const value = (sharer ?? "").trim();
	if (!value || value === "unknown" || /^ou_[a-z0-9]+$/i.test(value)) return "飞书用户";
	return value;
}
