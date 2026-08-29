import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { KnowledgeRecord } from "./types.js";
import { SOURCE_TYPE_LABELS } from "./types.js";

export class KnowledgeStore {
	private readonly recordsPath: string;
	private readonly docPath: string;

	constructor(config: Config) {
		this.recordsPath = join(config.dataDir, "records.json");
		this.docPath = join(config.dataDir, "knowledge.md");
	}

	async list(): Promise<KnowledgeRecord[]> {
		try {
			return JSON.parse(await readFile(this.recordsPath, "utf8"));
		} catch {
			return [];
		}
	}

	async save(record: KnowledgeRecord): Promise<void> {
		const records = await this.list();
		const existingIndex = records.findIndex((item) => item.url === record.url);
		if (existingIndex >= 0) records[existingIndex] = record;
		else records.unshift(record);
		await writeFile(this.recordsPath, JSON.stringify(records, null, 2), "utf8");
		await writeFile(this.docPath, renderMarkdown(records), "utf8");
	}

	async search(query: string, limit = 8): Promise<KnowledgeRecord[]> {
		const terms = tokenize(query);
		if (!terms.length) return [];
		const records = await this.list();
		const scored = records
			.map((record) => ({ record, score: scoreRecord(record, terms) }))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score);
		if (!scored.length) return [];
		const cutoff = scored[0].score * RELATIVE_SCORE_CUTOFF;
		return scored
			.filter((item) => item.score >= cutoff)
			.slice(0, limit)
			.map((item) => item.record);
	}
}

const RELATIVE_SCORE_CUTOFF = 0.25;

const CJK_PATTERN = /[\u4e00-\u9fff]+/g;
const LATIN_PATTERN = /[a-z0-9][a-z0-9+.#_-]*/g;

const STOPWORDS = new Set([
	"的",
	"了",
	"吗",
	"呢",
	"吧",
	"是",
	"有",
	"和",
	"与",
	"我",
	"你",
	"他",
	"们",
	"这",
	"那",
	"个",
	"一个",
	"没有",
	"有没",
	"什么",
	"怎么",
	"哪个",
	"哪些",
	"可以",
	"能不",
	"不能",
	"帮我",
	"给我",
	"推荐",
	"一下",
	"这个",
	"那个",
	"关于",
	"以及",
	"还有",
	"the",
	"and",
	"for",
	"with",
	"you",
	"any",
]);

/**
 * Chinese queries carry no spaces, so whitespace splitting produced a single
 * long token that never matched. Split CJK runs into overlapping 2-grams and
 * keep latin words as-is.
 */
function tokenize(text: string): string[] {
	const normalized = text.toLowerCase();
	const terms = new Set<string>();

	for (const run of normalized.match(CJK_PATTERN) ?? []) {
		if (run.length === 1) {
			terms.add(run);
			continue;
		}
		for (let index = 0; index + 2 <= run.length; index += 1) {
			terms.add(run.slice(index, index + 2));
		}
		if (run.length <= 8) terms.add(run);
	}

	for (const word of normalized.match(LATIN_PATTERN) ?? []) {
		if (word.length >= 2) terms.add(word);
	}

	return [...terms].filter((term) => !STOPWORDS.has(term));
}

const FIELD_WEIGHTS = [
	{ weight: 6, pick: (record: KnowledgeRecord) => record.title },
	{ weight: 4, pick: (record: KnowledgeRecord) => `${record.category} ${record.tags.join(" ")}` },
	{ weight: 3, pick: (record: KnowledgeRecord) => `${record.useCases.join(" ")} ${record.keyPoints.join(" ")}` },
	{ weight: 2, pick: (record: KnowledgeRecord) => record.summary },
	{ weight: 1, pick: (record: KnowledgeRecord) => record.rawText.slice(0, 5000) },
];

function scoreRecord(record: KnowledgeRecord, terms: string[]) {
	const fields = FIELD_WEIGHTS.map((field) => ({ weight: field.weight, text: field.pick(record).toLowerCase() }));
	let score = 0;
	for (const term of terms) {
		// A 4-character term matching is stronger evidence than a 2-gram matching.
		const specificity = Math.min(term.length, 4) / 2;
		for (const field of fields) {
			if (field.text.includes(term)) score += field.weight * specificity;
		}
	}
	return score;
}

function renderMarkdown(records: KnowledgeRecord[]) {
	const byCategory = new Map<string, KnowledgeRecord[]>();
	for (const record of records) {
		const category = record.category || "未分类";
		byCategory.set(category, [...(byCategory.get(category) ?? []), record]);
	}

	const lines = ["# 产品资料库", "", `更新时间：${new Date().toISOString()}`, ""];
	for (const [category, categoryRecords] of [...byCategory.entries()].sort()) {
		lines.push(`## ${category}`, "");
		for (const record of categoryRecords) {
			lines.push(`### ${record.title}`);
			lines.push(`- 原链接：${record.url}`);
			lines.push(`- 来源类型：${SOURCE_TYPE_LABELS[record.sourceType] ?? record.sourceType}`);
			lines.push(`- 标签：${record.tags.join("、") || "-"}`);
			lines.push(`- 适用场景：${record.useCases.join("；") || "-"}`);
			lines.push(`- 摘要：${record.summary}`);
			if (record.images.length) lines.push(`- 图片：${record.images.join(", ")}`);
			if (record.keyPoints.length) {
				lines.push("- 要点：");
				for (const point of record.keyPoints) lines.push(`  - ${point}`);
			}
			lines.push("");
		}
	}
	return `${lines.join("\n")}\n`;
}
