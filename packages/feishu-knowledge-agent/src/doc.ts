/**
 * Mirrors the knowledge base into a Feishu doc so it can be browsed from chat
 * instead of only living in `.knowledge/knowledge.md` on the server disk.
 *
 * Blocks are built from the records rather than by parsing the generated
 * markdown, so the doc never drifts from `records.json`.
 */

import type { KnowledgeRecord } from "./types.js";
import { SOURCE_TYPE_LABELS } from "./types.js";

export type DocBlock = Record<string, unknown>;

const BLOCK_TEXT = 2;
const BLOCK_HEADING1 = 3;
const BLOCK_HEADING2 = 4;
const BLOCK_HEADING3 = 5;
const BLOCK_BULLET = 12;

/** Feishu rejects oversized text runs, and a card-length summary is enough for browsing. */
const MAX_RUN_LENGTH = 1500;

function block(type: number, key: string, content: string): DocBlock {
	return { block_type: type, [key]: { elements: [{ text_run: { content: truncate(content) } }] } };
}

function truncate(text: string) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_RUN_LENGTH ? `${collapsed.slice(0, MAX_RUN_LENGTH - 1)}…` : collapsed;
}

export function buildKnowledgeBlocks(records: KnowledgeRecord[]): DocBlock[] {
	const blocks: DocBlock[] = [
		block(BLOCK_HEADING1, "heading1", "产品资料库"),
		block(
			BLOCK_TEXT,
			"text",
			`共 ${records.length} 条 · 更新于 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
		),
	];

	if (!records.length) {
		blocks.push(block(BLOCK_TEXT, "text", "还没有收录任何资料。把链接发给 Mark 就会出现在这里。"));
		return blocks;
	}

	const byCategory = new Map<string, KnowledgeRecord[]>();
	for (const record of records) {
		const category = record.category || "未分类";
		byCategory.set(category, [...(byCategory.get(category) ?? []), record]);
	}

	for (const [category, categoryRecords] of [...byCategory.entries()].sort()) {
		blocks.push(block(BLOCK_HEADING2, "heading2", `${category}（${categoryRecords.length}）`));
		for (const record of categoryRecords) {
			blocks.push(block(BLOCK_HEADING3, "heading3", record.title));
			const facts = [
				SOURCE_TYPE_LABELS[record.sourceType] ?? record.sourceType,
				record.tags.length ? record.tags.join("、") : undefined,
			].filter(Boolean);
			blocks.push(block(BLOCK_TEXT, "text", facts.join(" · ")));
			blocks.push(block(BLOCK_TEXT, "text", `分享者：${readableSharer(record.sharer)}`));
			blocks.push(block(BLOCK_TEXT, "text", record.url));
			if (record.summary) blocks.push(block(BLOCK_TEXT, "text", record.summary));
			if (record.useCases.length) {
				blocks.push(block(BLOCK_TEXT, "text", `适用场景：${record.useCases.join("；")}`));
			}
			for (const point of record.keyPoints) {
				blocks.push(block(BLOCK_BULLET, "bullet", point));
			}
		}
	}

	return blocks;
}

function readableSharer(sharer: string) {
	const value = sharer.trim();
	if (!value || value === "unknown" || /^ou_[a-z0-9]+$/i.test(value)) return "飞书用户";
	return value;
}
