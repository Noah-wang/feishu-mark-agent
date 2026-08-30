import assert from "node:assert/strict";
import test from "node:test";
import { runDecisionAgent } from "../dist/decisionAgent.js";

const config = {
	decision: {
		maxSteps: 8,
		maxSources: 3,
		internalSearchLimit: 5,
		webSearchEnabled: true,
		webSearchProvider: "custom",
		webSearchApiKey: "",
		webSearchUrl: "https://search.example?q={query}",
		webSearchTimeoutMs: 1000,
	},
};

const internalRecord = {
	id: "record-1",
	url: "https://internal.example/alpha",
	sourceType: "article",
	title: "Alpha 团队试用记录",
	summary: "团队试用后认为中文效果稳定。",
	category: "AI 工具",
	tags: [],
	useCases: ["中文字幕"],
	keyPoints: ["已实际试用"],
	images: [],
	metadata: {},
	sharer: "测试用户",
	sharerId: "ou_test",
	createdAt: "2026-08-30T00:00:00.000Z",
	rawText: "内部试用结果",
};

test("runDecisionAgent asks at most one critical clarification before using tools", async () => {
	let searches = 0;
	const store = { search: async () => (searches += 1, []) };
	const outcome = await runDecisionAgent(
		"帮我选一个",
		"测试用户",
		"ou_test",
		store,
		config,
		{ allowClarification: true },
		{
			planBrief: async () => ({
				goal: "选择方案",
				hardConstraints: [],
				preferences: [],
				assumptions: [],
				clarificationQuestion: "你想选什么类型的方案？",
				internalQueries: [],
				publicSearchQueries: [],
			}),
		},
	);
	assert.deepEqual(outcome, { kind: "clarification", question: "你想选什么类型的方案？" });
	assert.equal(searches, 0);
});

test("runDecisionAgent combines internal evidence with actually-read web sources", async () => {
	const progress = [];
	const store = { search: async () => [internalRecord] };
	const outcome = await runDecisionAgent(
		"选一个中文字幕服务",
		"测试用户",
		"ou_test",
		store,
		config,
		{ allowClarification: false, onProgress: (item) => progress.push(item.stage) },
		{
			planBrief: async () => ({
				goal: "选择中文字幕服务",
				hardConstraints: ["支持中文"],
				preferences: ["成本低"],
				assumptions: [],
				clarificationQuestion: "",
				internalQueries: ["中文字幕"],
				publicSearchQueries: ["中文字幕 API 对比"],
			}),
			searchWeb: async () => [{ title: "Beta 官网", url: "https://beta.example/docs", snippet: "API docs" }],
			extractContent: async (url) => ({
				url,
				sourceType: "article",
				title: "Beta 官网",
				text: "Beta 支持中文字幕 API。",
				images: [],
				metadata: {},
			}),
			synthesize: async (_question, _brief, evidence) => ({
				recommendation: "先试用 Alpha",
				rationale: "团队已有使用经验。",
				alternatives: ["Beta 作为备选"],
				criteria: [{ name: "中文", requirement: "支持中文字幕" }],
				candidates: [
					{
						name: "Alpha",
						url: evidence[0].url,
						summary: "已有团队证据",
						conditions: [{ criterion: "中文", status: "met", reason: "已试用", evidenceIds: ["1"] }],
						advantages: ["团队验证"],
						risks: [],
						unknowns: [],
						evidenceIds: ["e1", "made-up"],
					},
				],
				risks: [],
				unknowns: [],
				nextSteps: ["小规模试用"],
				confidence: "medium",
			}),
			now: () => new Date("2026-08-30T12:00:00.000Z"),
		},
	);

	assert.equal(outcome.kind, "completed");
	assert.equal(outcome.decision.evidence.length, 2);
	assert.deepEqual(outcome.decision.evidence.map((item) => item.id), ["E1", "E2"]);
	assert.deepEqual(outcome.decision.candidates[0].evidenceIds, ["E1"]);
	assert.ok(progress.includes("knowledge_search"));
	assert.ok(progress.includes("web_search"));
	assert.ok(progress.includes("reading_sources"));
	assert.ok(progress.includes("comparing"));
});
