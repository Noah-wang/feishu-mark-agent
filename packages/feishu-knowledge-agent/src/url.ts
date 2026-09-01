import type { SourceType } from "./types.js";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(text: string): string[] {
	const matches = text.match(URL_PATTERN) ?? [];
	return [...new Set(matches.map((url) => url.replace(/[),.，。]+$/, "")))];
}

export function classifyUrl(url: string): SourceType {
	const host = safeHost(url);
	if (!host) return "unknown";
	if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com") || host.endsWith(".x.com"))
		return "x";
	if (host === "github.com" || host.endsWith(".github.com")) return "github";
	if (host.includes("bilibili.com") || host === "b23.tv") return "bilibili";
	if (isYoutubeHost(host)) return "youtube";
	if (/\.(mp4|mov|m4v|webm)(\?|$)/i.test(url)) return "video";
	return "article";
}

export function parseTweetId(url: string): string | undefined {
	const match = url.match(/\/status(?:es)?\/(\d+)/);
	return match?.[1];
}

export function parseGithubRepo(url: string): { owner: string; repo: string } | undefined {
	const parsed = safeUrl(url);
	if (!parsed || parsed.hostname !== "github.com") return undefined;
	const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
	if (!owner || !repo) return undefined;
	return { owner, repo: repo.replace(/\.git$/, "") };
}

export function parseBilibiliId(url: string): string | undefined {
	return (
		url.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] ??
		url.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i)?.[1] ??
		url.match(/\/video\/av(\d+)/i)?.[1] ??
		url.match(/[?&]aid=(\d+)/i)?.[1]
	);
}

export function parseYoutubeVideoId(url: string): string | undefined {
	const parsed = safeUrl(url);
	if (!parsed) return undefined;
	const host = parsed.hostname.toLowerCase();
	if (host === "youtu.be") return cleanYoutubeId(parsed.pathname.split("/").filter(Boolean)[0]);
	if (!isYoutubeHost(host)) return undefined;

	const fromQuery = parsed.searchParams.get("v");
	if (fromQuery) return cleanYoutubeId(fromQuery);

	const [first, second] = parsed.pathname.split("/").filter(Boolean);
	if (["embed", "shorts", "live"].includes(first ?? "")) return cleanYoutubeId(second);
	return undefined;
}

function isYoutubeHost(host: string) {
	return host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com");
}

function cleanYoutubeId(value: string | undefined) {
	const match = value?.match(/^[A-Za-z0-9_-]{11}/);
	return match?.[0];
}

function safeHost(url: string) {
	return safeUrl(url)?.hostname.toLowerCase();
}

function safeUrl(url: string) {
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

/**
 * Short links defeat the store's URL-based deduplication: b23.tv/uTRT1O1 and
 * b23.tv/Prp34ye both point at BV1z9t86dEc2, and both were archived as separate
 * records. Storing the canonical form makes the same video the same URL, and it
 * also outlives short links, which expire.
 */
export function canonicalBilibiliUrl(videoId: string) {
	return /^BV/i.test(videoId)
		? `https://www.bilibili.com/video/${videoId}/`
		: `https://www.bilibili.com/video/av${videoId}/`;
}

export function canonicalYoutubeUrl(videoId: string) {
	return `https://www.youtube.com/watch?v=${videoId}`;
}
