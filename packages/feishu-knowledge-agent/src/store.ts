import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { KnowledgeRecord } from "./types.js";
import { readableSharer, SOURCE_TYPE_LABELS } from "./types.js";

export class KnowledgeStore {
	private readonly recordsPath: string;
	private readonly docPath: string;

	constructor(config: Config) {
		this.recordsPath = join(config.dataDir, "records.json");
		this.docPath = join(config.dataDir, "knowledge.md");
	}

	async list(): Promise<KnowledgeRecord[]> {
		try {
			const parsed = JSON.parse(await readFile(this.recordsPath, "utf8"));
			return Array.isArray(parsed) ? parsed.map(normalizeRecord) : [];
		} catch {
			return [];
		}
	}

	async save(record: KnowledgeRecord): Promise<void> {
		const records = await this.list();
		const existingIndex = records.findIndex((item) => item.url === record.url);
		if (existingIndex >= 0) records[existingIndex] = record;
		else records.unshift(record);
		await this.writeRecords(records);
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

	async findForDeletion(query: string, urls: string[], limit = 8): Promise<KnowledgeRecord[]> {
		const records = await this.list();
		if (!records.length) return [];
		const normalizedUrls = new Set(urls.map(normalizeUrlForMatch));
		if (normalizedUrls.size) {
			return records.filter((record) => normalizedUrls.has(normalizeUrlForMatch(record.url))).slice(0, limit);
		}
		return this.search(stripDeleteWords(query), limit);
	}

	async deleteByIds(ids: string[]): Promise<KnowledgeRecord[]> {
		if (!ids.length) return [];
		const idSet = new Set(ids);
		const records = await this.list();
		const deleted = records.filter((record) => idSet.has(record.id));
		if (!deleted.length) return [];
		await this.writeRecords(records.filter((record) => !idSet.has(record.id)));
		return deleted;
	}

	private async writeRecords(records: KnowledgeRecord[]): Promise<void> {
		await writeFile(this.recordsPath, JSON.stringify(records, null, 2), "utf8");
		await writeFile(this.docPath, renderMarkdown(records), "utf8");
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
	// A human saying why something matters is a stronger signal than a generated summary.
	{ weight: 5, pick: (record: KnowledgeRecord) => record.recommendation },
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

function stripDeleteWords(text: string) {
	return text
		.replace(/(帮我|请|把|这个|那个|一篇|文章|资料|记录|知识库|资料库)/g, " ")
		.replace(/(删除|删掉|去掉|移除|清除|取消收录|不要收录|delete|remove|clear)/gi, " ")
		.trim();
}

function normalizeUrlForMatch(url: string) {
	return url.trim().replace(/\/+$/, "");
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
			lines.push(`- 分享者：${readableSharer(record.sharer)}`);
			if (record.recommendation) lines.push(`- 推荐理由：${record.recommendation}`);
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

/**
 * Records written before a field existed do not carry it, and `JSON.parse` returns
 * `any`, so the compiler cannot catch the gap. `sharer` was added after the first
 * records were archived, and every render then crashed on `sharer.trim()`.
 * Normalising here keeps that whole class of bug away from the rest of the code.
 */
function normalizeRecord(raw: Partial<KnowledgeRecord> | null | undefined): KnowledgeRecord {
	const record = raw ?? {};
	return {
		id: String(record.id ?? ""),
		url: String(record.url ?? ""),
		sourceType: record.sourceType ?? "unknown",
		title: String(record.title ?? ""),
		summary: String(record.summary ?? ""),
		category: String(record.category ?? "未分类"),
		tags: stringArray(record.tags),
		useCases: stringArray(record.useCases),
		keyPoints: stringArray(record.keyPoints),
		images: stringArray(record.images),
		metadata: typeof record.metadata === "object" && record.metadata ? record.metadata : {},
		createdAt: String(record.createdAt ?? ""),
		rawText: String(record.rawText ?? ""),
		sharer: String(record.sharer ?? ""),
		// Records archived before ownership was tracked fall back to `sharer`, which held
		// a raw open_id whenever the contact scope was missing.
		sharerId: String(record.sharerId ?? (isOpenId(record.sharer) ? record.sharer : "")),
		recommendation: String(record.recommendation ?? ""),
	};
}

function isOpenId(value: unknown): value is string {
	return typeof value === "string" && /^ou_[a-z0-9]+$/i.test(value.trim());
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}
