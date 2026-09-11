/**
 * Product Hunt daily digest.
 *
 * The Atom feed is the only source reachable from a server: the homepage answers
 * datacenter IPs with 403, and the GraphQL API needs an OAuth developer token.
 * Measured from the Singapore host — the feed returns 200 with the product name,
 * maker, link and description for each entry.
 *
 * Entries carry a link back to Product Hunt and only a short excerpt of the
 * description, because this is a pointer to the source rather than a copy of it.
 */

import type { Config } from "./config.js";

export interface ProductHuntEntry {
	name: string;
	tagline: string;
	url: string;
	maker: string;
	publishedAt: string;
}

const FEED_URL = "https://www.producthunt.com/feed";
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** Long enough to say what a product is, short enough to stay a pointer. */
const MAX_TAGLINE = 90;

export async function fetchProductHunt(config: Config): Promise<ProductHuntEntry[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.productHunt.timeoutMs);
	try {
		const response = await fetch(FEED_URL, {
			signal: controller.signal,
			headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/atom+xml,application/xml" },
		});
		if (!response.ok) throw new Error(`Product Hunt feed returned HTTP ${response.status}`);
		return parseFeed(await response.text());
	} finally {
		clearTimeout(timer);
	}
}

function parseFeed(xml: string): ProductHuntEntry[] {
	const entries: ProductHuntEntry[] = [];
	for (const chunk of xml.split(/<entry[\s>]/).slice(1)) {
		const name = decodeXml(tagText(chunk, "title"));
		const url = chunk.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "";
		if (!name || !url) continue;
		entries.push({
			name,
			tagline: truncate(stripFeedFooter(stripHtml(decodeXml(tagText(chunk, "content"))))),
			url,
			maker: decodeXml(stripHtml(tagText(chunk, "author"))),
			publishedAt: tagText(chunk, "published") || tagText(chunk, "updated"),
		});
	}
	return entries;
}

/**
 * Newest first, capped. Deliberately not filtered to "today": Product Hunt stamps
 * entries in US Pacific and the feed lags, so a morning push in Asia would look at
 * a local day the feed has nothing for and send an empty digest.
 */
export function topEntries(entries: ProductHuntEntry[], limit: number): ProductHuntEntry[] {
	return [...entries].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, limit);
}

export function localDay(iso: string, now = new Date()): string {
	const date = iso ? new Date(iso) : now;
	if (Number.isNaN(date.getTime())) return "";
	// Local rather than UTC: the digest is scheduled against the server's clock, and
	// Product Hunt timestamps are US Pacific, so a UTC day would split one PH day in two.
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number) {
	return String(value).padStart(2, "0");
}

function tagText(chunk: string, tag: string) {
	return chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
}

function stripHtml(text: string) {
	return text
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Every entry's description ends with the feed's own "Discussion | Link" footer. */
function stripFeedFooter(text: string) {
	return text.replace(/\s*(Discussion\s*\|\s*Link)\s*$/i, "").trim();
}

function decodeXml(text: string) {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function truncate(text: string) {
	return text.length > MAX_TAGLINE ? `${text.slice(0, MAX_TAGLINE - 1)}…` : text;
}
