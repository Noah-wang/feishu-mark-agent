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
	createdAt: string;
	rawText: string;
}

export interface Recommendation {
	answer: string;
	candidates: Array<{
		id: string;
		title: string;
		url: string;
		reason: string;
	}>;
}

export type MessageIntentName = "archive_links" | "ask_question" | "list_records" | "server_status" | "help";

export interface MessageIntent {
	intent: MessageIntentName;
	query: string;
	reason: string;
}

export interface IncomingMessage {
	messageId: string;
	chatId: string;
	senderId: string;
	text: string;
	mentionsBot: boolean;
}
