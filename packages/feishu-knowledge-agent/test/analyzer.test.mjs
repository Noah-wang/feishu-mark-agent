import assert from "node:assert/strict";
import test from "node:test";
import { planAgentAction } from "../dist/analyzer.js";

const config = { llm: { baseUrl: "", apiKey: "", model: "", timeoutMs: 1000 } };

test("planner fallback routes selection requests to the decision agent", async () => {
	const plan = await planAgentAction("预算每月 3000 元，帮我选一个社媒监测方案", [], config);
	assert.equal(plan.action, "make_decision");
});

test("planner fallback routes previous-choice questions to decision history", async () => {
	const plan = await planAgentAction("上次为什么没选 Beta 方案？", [], config);
	assert.equal(plan.action, "query_decisions");
});

test("planner fallback leaves explanatory questions in normal knowledge Q&A", async () => {
	const plan = await planAgentAction("什么是 RAG？", [], config);
	assert.equal(plan.action, "ask_question");
});
