/**
 * Mirrors the knowledge base into a Feishu doc so it can be browsed from chat
 * instead of only living in `.knowledge/knowledge.md` on the server disk.
 *
 * Blocks are built from the records rather than by parsing the generated
 * markdown, so the doc never drifts from `records.json`.
 */

import type { KnowledgeRecord } from "./types.js";
import { readableSharer, SOURCE_TYPE_LABELS } from "./types.js";

export type DocBlock = Record<string, unknown>;

export const BLOCK_TEXT = 2;
export const BLOCK_HEADING1 = 3;
export const BLOCK_HEADING2 = 4;
export const BLOCK_HEADING3 = 5;
export const BLOCK_BULLET = 12;
export const BLOCK_IMAGE = 27;

/** Feishu rejects oversized text runs, and a card-length summary is enough for browsing. */
const MAX_RUN_LENGTH = 1500;

function block(type: number, key: string, content: string): DocBlock {
	return { block_type: type, [key]: { elements: [{ text_run: { content: truncate(content) } }] } };
}

function truncate(text: string) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_RUN_LENGTH ? `${collapsed.slice(0, MAX_RUN_LENGTH - 1)}…` : collapsed;
}

/**
 * `imageRecords` lists the records that produced an image block, in the same order
 * the blocks appear. The caller pairs them up to upload each cover, so the ordering
 * must come from this traversal rather than being recomputed.
 */
export function buildKnowledgeBlocks(records: KnowledgeRecord[]): {
	blocks: DocBlock[];
	imageRecords: KnowledgeRecord[];
} {
	const blocks: DocBlock[] = [
		block(BLOCK_HEADING1, "heading1", "产品资料库"),
		block(BLOCK_TEXT, "text", summaryText(records.length)),
	];
	const imageRecords: KnowledgeRecord[] = [];

	if (!records.length) {
		blocks.push(block(BLOCK_TEXT, "text", "还没有收录任何资料。把链接发给 Mark 就会出现在这里。"));
		return { blocks, imageRecords };
	}

	const byCategory = new Map<string, KnowledgeRecord[]>();
	for (const record of records) {
		const category = record.category || "未分类";
		byCategory.set(category, [...(byCategory.get(category) ?? []), record]);
	}

	for (const [category, categoryRecords] of [...byCategory.entries()].sort()) {
		blocks.push(categoryHeadingBlock(category, categoryRecords.length));
		for (const record of categoryRecords) {
			blocks.push(...buildRecordBlocks(record));
			if (coverImageUrl(record)) imageRecords.push(record);
		}
	}

	return { blocks, imageRecords };
}

/** Blocks for a single record, used both by the full rebuild and by incremental inserts. */
export function buildRecordBlocks(record: KnowledgeRecord): DocBlock[] {
	const blocks: DocBlock[] = [block(BLOCK_HEADING3, "heading3", record.title)];
	// An image block is created empty; the media is uploaded against its block id
	// afterwards, because Feishu has no way to insert an image by URL.
	if (coverImageUrl(record)) blocks.push({ block_type: BLOCK_IMAGE, image: {} });
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
	return blocks;
}

/** The first image is the cover; later entries are fallbacks for when it fails to download. */
export function coverImageUrl(record: KnowledgeRecord): string | undefined {
	return record.images.find((url) => /^https?:\/\//i.test(url));
}

export function categoryHeadingBlock(category: string, count: number): DocBlock {
	return block(BLOCK_HEADING2, "heading2", categoryHeadingText(category, count));
}

export function categoryHeadingText(category: string, count: number) {
	return `${category}（${count}）`;
}

/** Reads back a heading written by `categoryHeadingText` so the count can be bumped in place. */
export function parseCategoryHeading(text: string): { category: string; count: number } | undefined {
	const match = text.trim().match(/^(.*)（(\d+)）$/);
	if (!match) return undefined;
	return { category: match[1], count: Number(match[2]) };
}

export function summaryText(total: number) {
	return `共 ${total} 条 · 更新于 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
}
