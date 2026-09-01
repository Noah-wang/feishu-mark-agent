import type { Config } from "./config.js";
import { searchMonidWeb } from "./monid.js";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Final guard before a query leaves Mark. The model is also told to produce
 * public-only queries, but deterministic redaction covers prompt mistakes.
 */
export function sanitizePublicSearchQuery(input: string): string {
	return input
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, " ")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
		.replace(/\b(?:sk|rk|pk|ghp|gho|github_pat)-?[A-Za-z0-9_-]{12,}\b/g, " ")
		.replace(/\bAKID[A-Za-z0-9]{8,}\b/g, " ")
		.replace(/\b(?:cli|ou|oc|on|om)_[A-Za-z0-9_-]{8,}\b/g, " ")
		.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, " ")
		.replace(/[\p{Script=Han}A-Za-z0-9_-]{2,30}(?:有限责任公司|有限公司|公司|集团)/gu, "企业")
		.replace(/(?:内部|私有|保密)(?:项目|系统|平台|代号)?[：:\s]*[\p{Script=Han}A-Za-z0-9_-]{2,30}/gu, "企业内部项目")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

export async function searchWeb(
	query: string,
	config: Config,
	fetchImpl: typeof fetch = fetch,
): Promise<WebSearchResult[]> {
	if (!config.decision.webSearchEnabled) return [];
	if (config.decision.webSearchProvider === "brave" && !config.decision.webSearchApiKey) {
		throw new Error("Web search needs MARK_WEB_SEARCH_API_KEY");
	}
	if (config.decision.webSearchProvider === "monid" && !config.decision.webSearchApiKey) {
		throw new Error("Monid search needs MONID_API_KEY");
	}
	const publicQuery = sanitizePublicSearchQuery(query);
	if (!publicQuery) return [];
	if (config.decision.webSearchProvider === "monid") {
		return dedupeResults(await searchMonidWeb(publicQuery, config, fetchImpl)).slice(
			0,
			config.decision.maxSources * 2,
		);
	}

	const endpoint = config.decision.webSearchUrl.replace("{query}", encodeURIComponent(publicQuery));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.decision.webSearchTimeoutMs);
	try {
		const response = await fetchImpl(endpoint, {
			signal: controller.signal,
			headers: {
				Accept: "application/json, application/rss+xml, application/xml, text/xml;q=0.9, text/html;q=0.8",
				"User-Agent": BROWSER_USER_AGENT,
				...(config.decision.webSearchProvider === "brave"
					? { "X-Subscription-Token": config.decision.webSearchApiKey }
					: {}),
			},
		});
		if (!response.ok) throw new Error(`Web search failed: HTTP ${response.status}`);
		const body = await response.text();
		const contentType = response.headers.get("content-type") ?? "";
		const results =
			contentType.includes("json") || body.trimStart().startsWith("{")
				? parseJsonResults(body)
				: parseRssResults(body);
		return dedupeResults(results).slice(0, config.decision.maxSources * 2);
	} finally {
		clearTimeout(timer);
	}
}

function parseJsonResults(body: string): WebSearchResult[] {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	const web = typeof parsed.web === "object" && parsed.web ? (parsed.web as Record<string, unknown>) : undefined;
	const raw = Array.isArray(web?.results)
		? web.results
		: Array.isArray(parsed.results)
			? parsed.results
			: Array.isArray(parsed.items)
				? parsed.items
				: [];
	return raw
		.map((item) => {
			const value = (item ?? {}) as Record<string, unknown>;
			return {
				title: String(value.title ?? value.name ?? "").trim(),
				url: String(value.url ?? value.link ?? "").trim(),
				snippet: String(value.content ?? value.snippet ?? value.description ?? "").trim(),
			};
		})
		.filter(validResult);
}

function parseRssResults(body: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	for (const match of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
		const item = match[1];
		const result = {
			title: xmlTag(item, "title"),
			url: xmlTag(item, "link"),
			snippet: stripHtml(xmlTag(item, "description")),
		};
		if (validResult(result)) results.push(result);
	}
	return results;
}

function xmlTag(xml: string, tag: string) {
	const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
	return decodeEntities((match?.[1] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
}

function stripHtml(value: string) {
	return decodeEntities(
		value
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function decodeEntities(value: string) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function validResult(result: WebSearchResult) {
	return Boolean(result.title && isSafePublicUrl(result.url));
}

export function isSafePublicUrl(value: string) {
	try {
		const url = new URL(value);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
		if (/^(?:127|0)\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
		if (/^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
		if (/^(?:0*:)*0*1$/.test(host) || /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(host)) return false;
		return true;
	} catch {
		return false;
	}
}

function dedupeResults(results: WebSearchResult[]) {
	const seen = new Set<string>();
	return results.filter((result) => {
		const key = normalizeUrl(result.url);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function normalizeUrl(value: string) {
	try {
		const url = new URL(value);
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/^(utm_|spm|from|source|ref)/i.test(key)) url.searchParams.delete(key);
		}
		return url.toString().replace(/\/$/, "");
	} catch {
		return "";
	}
}
