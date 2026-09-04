/**
 * Token accounting for the LLM calls Mark makes.
 *
 * Aggregated by day, model and purpose rather than stored per call: the useful
 * questions are "what did today cost" and "which feature burns tokens", and one
 * row per call would grow without bound for no extra answer.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";

export type UsagePurpose =
	| "plan"
	| "intent"
	| "archive"
	| "requirement"
	| "answer"
	| "translate"
	| "decision"
	| "other";

export interface UsageCall {
	/** What the API said it served, which is not always the configured model. */
	model: string;
	purpose: UsagePurpose;
	promptTokens: number;
	completionTokens: number;
	/** Cached prompt tokens, billed far cheaper by DeepSeek and others. */
	cachedPromptTokens: number;
}

interface UsageBucket extends UsageCall {
	day: string;
	calls: number;
}

export interface UsageSummary {
	totalCalls: number;
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
	byModel: Array<{ model: string; calls: number; promptTokens: number; completionTokens: number }>;
	byPurpose: Array<{ purpose: UsagePurpose; calls: number; tokens: number }>;
	firstDay: string;
	lastDay: string;
}

const PURPOSE_LABELS: Record<UsagePurpose, string> = {
	plan: "理解意图",
	intent: "意图分类",
	archive: "收录分析",
	requirement: "需求拆解",
	answer: "问答与推荐",
	translate: "翻译改写",
	decision: "决策研究",
	other: "其他",
};

export function purposeLabel(purpose: UsagePurpose) {
	return PURPOSE_LABELS[purpose] ?? purpose;
}

export class UsageStore {
	private readonly path: string;
	/** Writes are serialised because several archive calls can finish at once. */
	private queue: Promise<void> = Promise.resolve();

	constructor(config: Config) {
		this.path = join(config.dataDir, "usage.json");
	}

	async record(call: UsageCall): Promise<void> {
		this.queue = this.queue
			.then(() => this.append(call))
			.catch((error) => {
				// Accounting must never break the feature it is measuring.
				console.warn("Failed to record LLM usage", error);
			});
		return this.queue;
	}

	async summary(sinceDays?: number): Promise<UsageSummary> {
		const buckets = await this.load();
		const cutoff = sinceDays ? dayKey(new Date(Date.now() - sinceDays * 86_400_000)) : "";
		const scoped = cutoff ? buckets.filter((bucket) => bucket.day >= cutoff) : buckets;

		const byModel = new Map<string, { calls: number; promptTokens: number; completionTokens: number }>();
		const byPurpose = new Map<UsagePurpose, { calls: number; tokens: number }>();
		let totalCalls = 0;
		let promptTokens = 0;
		let cachedPromptTokens = 0;
		let completionTokens = 0;

		for (const bucket of scoped) {
			totalCalls += bucket.calls;
			promptTokens += bucket.promptTokens;
			cachedPromptTokens += bucket.cachedPromptTokens;
			completionTokens += bucket.completionTokens;

			const model = byModel.get(bucket.model) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
			model.calls += bucket.calls;
			model.promptTokens += bucket.promptTokens;
			model.completionTokens += bucket.completionTokens;
			byModel.set(bucket.model, model);

			const purpose = byPurpose.get(bucket.purpose) ?? { calls: 0, tokens: 0 };
			purpose.calls += bucket.calls;
			purpose.tokens += bucket.promptTokens + bucket.completionTokens;
			byPurpose.set(bucket.purpose, purpose);
		}

		const days = scoped.map((bucket) => bucket.day).sort();
		return {
			totalCalls,
			promptTokens,
			cachedPromptTokens,
			completionTokens,
			byModel: [...byModel.entries()]
				.map(([model, value]) => ({ model, ...value }))
				.sort((a, b) => b.calls - a.calls),
			byPurpose: [...byPurpose.entries()]
				.map(([purpose, value]) => ({ purpose, ...value }))
				.sort((a, b) => b.tokens - a.tokens),
			firstDay: days[0] ?? "",
			lastDay: days[days.length - 1] ?? "",
		};
	}

	private async append(call: UsageCall): Promise<void> {
		const buckets = await this.load();
		const day = dayKey(new Date());
		const existing = buckets.find(
			(bucket) => bucket.day === day && bucket.model === call.model && bucket.purpose === call.purpose,
		);
		if (existing) {
			existing.calls += 1;
			existing.promptTokens += call.promptTokens;
			existing.completionTokens += call.completionTokens;
			existing.cachedPromptTokens += call.cachedPromptTokens;
		} else {
			buckets.push({ ...call, day, calls: 1 });
		}
		await writeFile(this.path, JSON.stringify(buckets, null, 2), "utf8");
	}

	private async load(): Promise<UsageBucket[]> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			return Array.isArray(parsed) ? parsed.map(normalizeBucket) : [];
		} catch {
			return [];
		}
	}
}

function normalizeBucket(raw: Partial<UsageBucket> | null | undefined): UsageBucket {
	const bucket = raw ?? {};
	return {
		day: String(bucket.day ?? ""),
		model: String(bucket.model ?? "unknown"),
		purpose: (bucket.purpose ?? "other") as UsagePurpose,
		calls: Number(bucket.calls) || 0,
		promptTokens: Number(bucket.promptTokens) || 0,
		completionTokens: Number(bucket.completionTokens) || 0,
		cachedPromptTokens: Number(bucket.cachedPromptTokens) || 0,
	};
}

function dayKey(date: Date) {
	return date.toISOString().slice(0, 10);
}

/**
 * Prices are per million tokens and come from configuration, because the endpoint
 * here is a reseller gateway and its rates are not discoverable from the API.
 * Without them the report shows tokens only rather than inventing a number.
 */
export function estimateCost(summary: UsageSummary, config: Config) {
	const { inputPer1M, cachedInputPer1M, outputPer1M, currency } = config.llm.pricing;
	if (!inputPer1M && !outputPer1M) return undefined;
	const freshPromptTokens = Math.max(0, summary.promptTokens - summary.cachedPromptTokens);
	const cost =
		(freshPromptTokens / 1_000_000) * inputPer1M +
		(summary.cachedPromptTokens / 1_000_000) * (cachedInputPer1M || inputPer1M) +
		(summary.completionTokens / 1_000_000) * outputPer1M;
	return { cost, currency };
}
