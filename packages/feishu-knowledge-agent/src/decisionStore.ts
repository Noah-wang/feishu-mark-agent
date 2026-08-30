import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { DecisionRecord } from "./types.js";

export class DecisionStore {
	private readonly recordsPath: string;
	private readonly markdownPath: string;

	constructor(config: Config) {
		this.recordsPath = join(config.dataDir, "decisions.json");
		this.markdownPath = join(config.dataDir, "decisions.md");
	}

	async list(): Promise<DecisionRecord[]> {
		try {
			const parsed = JSON.parse(await readFile(this.recordsPath, "utf8"));
			return Array.isArray(parsed) ? parsed.map(normalizeDecision) : [];
		} catch {
			return [];
		}
	}

	async save(decision: DecisionRecord): Promise<void> {
		const records = await this.list();
		const index = records.findIndex((item) => item.id === decision.id);
		if (index >= 0) records[index] = decision;
		else records.unshift(decision);
		await atomicWrite(this.recordsPath, `${JSON.stringify(records, null, 2)}\n`);
		await atomicWrite(this.markdownPath, renderDecisionMarkdown(records));
	}

	async search(query: string, limit = 5): Promise<DecisionRecord[]> {
		const records = await this.list();
		const terms = tokenize(query);
		if (!terms.length) return records.slice(0, limit);
		return records
			.map((decision) => ({ decision, score: scoreDecision(decision, terms) }))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((item) => item.decision);
	}
}

export function renderDecisionMarkdown(records: DecisionRecord[]) {
	const lines = ["# Mark 决策中心", "", `共 ${records.length} 条决策 · 更新于 ${new Date().toISOString()}`, ""];
	if (!records.length) lines.push("还没有保存任何决策。", "");

	for (const decision of records) {
		lines.push(`## ${decision.question}`);
		lines.push(`- 状态：${decisionStatusLabel(decision.status)}`);
		lines.push(`- 发起人：${decision.requester || "飞书用户"}`);
		lines.push(`- 时间：${decision.createdAt}`);
		lines.push(`- 目标：${decision.goal}`);
		if (decision.hardConstraints.length) lines.push(`- 硬性条件：${decision.hardConstraints.join("；")}`);
		if (decision.assumptions.length) lines.push(`- 假设：${decision.assumptions.join("；")}`);
		lines.push("", "### 建议", "", decision.recommendation, "", decision.rationale, "");
		if (decision.candidates.length) {
			lines.push("### 候选方案", "");
			for (const candidate of decision.candidates) {
				lines.push(`- **${candidate.name}**${candidate.url ? `：${candidate.url}` : ""}`);
				lines.push(`  ${candidate.summary}`);
			}
			lines.push("");
		}
		if (decision.risks.length) lines.push("### 风险", "", ...decision.risks.map((item) => `- ${item}`), "");
		if (decision.unknowns.length) lines.push("### 待验证", "", ...decision.unknowns.map((item) => `- ${item}`), "");
		if (decision.nextSteps.length) lines.push("### 下一步", "", ...decision.nextSteps.map((item) => `- ${item}`), "");
		if (decision.evidence.length) {
			lines.push("### 证据", "");
			for (const evidence of decision.evidence) {
				lines.push(`- [${evidence.title}](${evidence.url}) · ${evidence.sourceKind}`);
			}
			lines.push("");
		}
	}
	return `${lines.join("\n")}\n`;
}

async function atomicWrite(path: string, content: string) {
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
}

function scoreDecision(decision: DecisionRecord, terms: string[]) {
	const fields = [
		{ weight: 5, text: `${decision.question} ${decision.goal} ${decision.recommendation}` },
		{ weight: 3, text: `${decision.hardConstraints.join(" ")} ${decision.preferences.join(" ")}` },
		{ weight: 2, text: decision.candidates.map((item) => `${item.name} ${item.summary}`).join(" ") },
		{ weight: 1, text: `${decision.rationale} ${decision.risks.join(" ")} ${decision.unknowns.join(" ")}` },
	].map((field) => ({ ...field, text: field.text.toLowerCase() }));
	return terms.reduce(
		(total, term) =>
			total + fields.reduce((score, field) => score + (field.text.includes(term) ? field.weight : 0), 0),
		0,
	);
}

function tokenize(text: string) {
	const normalized = text.toLowerCase();
	const terms = new Set<string>();
	for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
		for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
	}
	for (const word of normalized.match(/[a-z0-9][a-z0-9+.#_-]*/g) ?? []) {
		if (word.length >= 2) terms.add(word);
	}
	return [...terms];
}

function normalizeDecision(raw: Partial<DecisionRecord> | null | undefined): DecisionRecord {
	const value = raw ?? {};
	return {
		id: String(value.id ?? ""),
		question: String(value.question ?? ""),
		requester: String(value.requester ?? ""),
		requesterId: String(value.requesterId ?? ""),
		goal: String(value.goal ?? ""),
		hardConstraints: strings(value.hardConstraints),
		preferences: strings(value.preferences),
		assumptions: strings(value.assumptions),
		evidence: Array.isArray(value.evidence) ? value.evidence : [],
		status: value.status ?? "recommended",
		createdAt: String(value.createdAt ?? ""),
		updatedAt: String(value.updatedAt ?? value.createdAt ?? ""),
		recommendation: String(value.recommendation ?? ""),
		rationale: String(value.rationale ?? ""),
		alternatives: strings(value.alternatives),
		criteria: Array.isArray(value.criteria) ? value.criteria : [],
		candidates: Array.isArray(value.candidates) ? value.candidates : [],
		risks: strings(value.risks),
		unknowns: strings(value.unknowns),
		nextSteps: strings(value.nextSteps),
		confidence: value.confidence ?? "low",
	};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function decisionStatusLabel(status: DecisionRecord["status"]) {
	return {
		researching: "研究中",
		recommended: "已建议",
		adopted: "已采用",
		rejected: "已放弃",
		needs_review: "需要复盘",
	}[status];
}
