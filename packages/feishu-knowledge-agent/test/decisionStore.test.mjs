import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionStore } from "../dist/decisionStore.js";

function decision(id, question, recommendation) {
	const now = "2026-08-30T12:00:00.000Z";
	return {
		id,
		question,
		requester: "测试用户",
		requesterId: "ou_test",
		goal: question,
		hardConstraints: ["支持中文"],
		preferences: [],
		assumptions: [],
		evidence: [],
		status: "recommended",
		createdAt: now,
		updatedAt: now,
		recommendation,
		rationale: "基于已读取的证据。",
		alternatives: [],
		criteria: [],
		candidates: [],
		risks: [],
		unknowns: [],
		nextSteps: ["试用"],
		confidence: "medium",
	};
}

test("DecisionStore saves, updates, searches, and mirrors markdown", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "mark-decisions-"));
	const store = new DecisionStore({ dataDir });
	await store.save(decision("a", "选一个 B 站字幕服务", "推荐 Alpha"));
	await store.save(decision("b", "选一个海外社媒监测服务", "推荐 Beta"));
	await store.save(decision("a", "选一个 B 站字幕服务", "推荐 Gamma"));

	const records = await store.list();
	assert.equal(records.length, 2);
	assert.equal(records.find((item) => item.id === "a")?.recommendation, "推荐 Gamma");
	assert.equal((await store.search("字幕"))[0].id, "a");
	const markdown = await readFile(join(dataDir, "decisions.md"), "utf8");
	assert.match(markdown, /Mark 决策中心/);
	assert.match(markdown, /推荐 Gamma/);
});
