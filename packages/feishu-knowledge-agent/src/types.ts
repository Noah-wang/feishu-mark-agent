export type SourceType = "x" | "github" | "bilibili" | "youtube" | "article" | "video" | "unknown";

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
	x: "X 推文",
	github: "GitHub 项目",
	bilibili: "B 站视频",
	youtube: "YouTube 视频",
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
	/** Why the sharer thinks this is worth reading. Their own words, not the model's. */
	recommendation: string;
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

export type DecisionStatus = "researching" | "recommended" | "adopted" | "rejected" | "needs_review";

export type DecisionConditionStatus = "met" | "partial" | "not_met" | "unknown";

export type DecisionSourceKind = "internal" | "official" | "independent" | "community";

export interface DecisionBrief {
	goal: string;
	hardConstraints: string[];
	preferences: string[];
	assumptions: string[];
	clarificationQuestion: string;
	internalQueries: string[];
	publicSearchQueries: string[];
}

export interface DecisionEvidence {
	id: string;
	title: string;
	url: string;
	snippet: string;
	content: string;
	sourceKind: DecisionSourceKind;
	fetchedAt: string;
	internalRecordId?: string;
}

export interface DecisionCriterion {
	name: string;
	requirement: string;
}

export interface DecisionConditionAssessment {
	criterion: string;
	status: DecisionConditionStatus;
	reason: string;
	evidenceIds: string[];
}

export interface DecisionCandidate {
	name: string;
	url: string;
	summary: string;
	conditions: DecisionConditionAssessment[];
	advantages: string[];
	risks: string[];
	unknowns: string[];
	evidenceIds: string[];
}

export interface DecisionResult {
	recommendation: string;
	rationale: string;
	alternatives: string[];
	criteria: DecisionCriterion[];
	candidates: DecisionCandidate[];
	risks: string[];
	unknowns: string[];
	nextSteps: string[];
	confidence: "high" | "medium" | "low";
}

export interface DecisionRecord extends DecisionResult {
	id: string;
	question: string;
	requester: string;
	requesterId: string;
	goal: string;
	hardConstraints: string[];
	preferences: string[];
	assumptions: string[];
	evidence: DecisionEvidence[];
	status: DecisionStatus;
	createdAt: string;
	updatedAt: string;
}

export type DecisionAgentOutcome =
	| { kind: "clarification"; question: string }
	| { kind: "completed"; decision: DecisionRecord; warnings: string[] };

export type MessageIntentName =
	| "archive_links"
	| "ask_question"
	| "make_decision"
	| "query_decisions"
	| "list_records"
	| "delete_records"
	| "server_status"
	| "help";

export type AgentActionName = MessageIntentName | "translate_records" | "clarify" | "add_recommendation";

/**
 * Describes an archive that just happened, so the planner can tell a comment about
 * it apart from a fresh request. Only set while the recommendation window is open.
 */
export interface RecentArchiveContext {
	titles: string[];
	windowMinutes: number;
}

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
