/**
 * The daily Product Hunt push.
 *
 * Timing is checked on a short interval rather than armed with one long
 * setTimeout: a multi-hour timer drifts when the host suspends, and pm2 restarts
 * would silently re-arm it from the wrong point. The last pushed day is written
 * to disk so a restart inside the push hour does not send the digest twice.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { translateProductHuntTaglines } from "./analyzer.js";
import type { Config } from "./config.js";
import type { FeishuCard, FeishuClient } from "./feishu.js";
import { fetchProductHunt, localDay, type ProductHuntEntry, topEntries } from "./productHunt.js";

/** Frequent enough to land inside the target hour, cheap enough to ignore. */
const TICK_MS = 5 * 60 * 1000;

export function startProductHuntDigest(feishu: FeishuClient, config: Config) {
	const chatId = config.productHunt.digestChatId.trim();
	if (!chatId) {
		console.info("Product Hunt digest disabled: PRODUCT_HUNT_DIGEST_CHAT_ID is empty");
		return undefined;
	}

	const statePath = join(config.dataDir, "producthunt-state.json");
	const tick = () => {
		void maybePush(statePath, chatId, feishu, config).catch((error) =>
			console.error("Product Hunt digest failed", error),
		);
	};

	const timer = setInterval(tick, TICK_MS);
	// Don't hold the process open for a push that is hours away.
	timer.unref?.();
	tick();
	console.info(`Product Hunt digest scheduled: chat=${chatId} hour=${config.productHunt.digestHour}`);
	return timer;
}

async function maybePush(statePath: string, chatId: string, feishu: FeishuClient, config: Config) {
	const now = new Date();
	if (now.getHours() < config.productHunt.digestHour) return;

	const today = localDay("", now);
	if ((await readLastPushedDay(statePath)) === today) return;

	const entries = topEntries(await fetchProductHunt(config), config.productHunt.maxItems);
	if (!entries.length) {
		// No state written: an empty feed is a transient failure, so the next tick retries.
		console.warn("Product Hunt digest skipped: feed returned no entries");
		return;
	}

	await feishu.sendCard(chatId, renderProductHuntCard(await localizeEntries(entries, config), now));
	await writeFile(statePath, JSON.stringify({ lastPushedDay: today }, null, 2), "utf8");
	console.info(`Sent Product Hunt digest: items=${entries.length} chat=${chatId}`);
}

async function readLastPushedDay(statePath: string): Promise<string> {
	try {
		const parsed = JSON.parse(await readFile(statePath, "utf8"));
		return typeof parsed?.lastPushedDay === "string" ? parsed.lastPushedDay : "";
	} catch {
		return "";
	}
}

/** Chinese descriptions, English product names: the names are how you search for them. */
export async function localizeEntries(entries: ProductHuntEntry[], config: Config): Promise<ProductHuntEntry[]> {
	const taglines = await translateProductHuntTaglines(
		entries.map((entry) => entry.tagline),
		config,
	);
	return entries.map((entry, index) => ({ ...entry, tagline: taglines[index] ?? entry.tagline }));
}

export function renderProductHuntCard(entries: ProductHuntEntry[], now = new Date()): FeishuCard {
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: {
			template: "orange",
			title: { tag: "plain_text", content: `Product Hunt 今日新品 · ${localDay("", now)}` },
		},
		elements: [
			{ tag: "div", text: { tag: "lark_md", content: renderProductHuntDigest(entries) } },
			{
				tag: "note",
				elements: [
					{
						tag: "plain_text",
						content: "来自 Product Hunt 官方 feed，点标题看原页面。想手动看就跟我说“看看 Product Hunt”。",
					},
				],
			},
		],
	};
}

export function renderProductHuntDigest(entries: ProductHuntEntry[]): string {
	if (!entries.length) return "没抓到新品，Product Hunt 的 feed 这会儿是空的，等下次再看。";
	return entries
		.map((entry, index) => {
			const lines = [`**${index + 1}. [${entry.name}](${entry.url})**`];
			if (entry.tagline) lines.push(entry.tagline);
			if (entry.maker) lines.push(`_by ${entry.maker}_`);
			return lines.join("\n");
		})
		.join("\n\n");
}
