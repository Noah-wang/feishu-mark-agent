import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionBlocks } from "../dist/decisionDoc.js";

test("buildDecisionBlocks includes conclusion, conditions, and evidence", () => {
	const decision = {
		id: "d1",
		question: "选哪个方案",
		requester: "测试用户",
		requesterId: "ou_test",
		goal: "选择方案",
		hardConstraints: ["支持中文"],
		preferences: [],
		assumptions: [],
		evidence: [{ id: "E1", title: "Alpha 官网", url: "https://example.com", snippet: "", content: "", sourceKind: "official", fetchedAt: "2026-08-30T00:00:00.000Z" }],
		status: "recommended",
		createdAt: "2026-08-30T00:00:00.000Z",
		updatedAt: "2026-08-30T00:00:00.000Z",
		recommendation: "推荐 Alpha",
		rationale: "它满足硬性条件。",
		alternatives: [],
		criteria: [{ name: "中文", requirement: "支持中文" }],
		candidates: [{ name: "Alpha", url: "https://example.com", summary: "候选", conditions: [{ criterion: "中文", status: "met", reason: "官方说明", evidenceIds: ["E1"] }], advantages: [], risks: [], unknowns: [], evidenceIds: ["E1"] }],
		risks: [],
		unknowns: [],
		nextSteps: ["试用"],
		confidence: "high",
	};
	const text = JSON.stringify(buildDecisionBlocks([decision]));
	assert.match(text, /Mark 决策中心/);
	assert.match(text, /推荐 Alpha/);
	assert.match(text, /\[满足\] 中文/);
	assert.match(text, /Alpha 官网/);
});
