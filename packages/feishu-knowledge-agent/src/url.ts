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
