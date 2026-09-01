import type { Config } from "./config.js";

export interface YoutubeVideoInfo {
	videoId: string;
	title: string;
	owner: string;
	durationSeconds: number;
	description: string;
	coverUrl: string;
}

export type YoutubeExtraction =
	| { kind: "subtitle"; info: YoutubeVideoInfo; lang: string; lineCount: number; text: string }
	| { kind: "no-subtitle"; info: YoutubeVideoInfo; reason: string };

interface YoutubeCaptionTrack {
	baseUrl?: string;
	languageCode?: string;
	kind?: string;
	vssId?: string;
	name?: { simpleText?: string; runs?: Array<{ text?: string }> };
	isTranslatable?: boolean;
}

interface YoutubePlayerResponse {
	videoDetails?: {
		videoId?: string;
		title?: string;
		author?: string;
		lengthSeconds?: string;
		shortDescription?: string;
		thumbnail?: { thumbnails?: Array<{ url?: string; width?: number; height?: number }> };
	};
	captions?: {
		playerCaptionsTracklistRenderer?: {
			captionTracks?: YoutubeCaptionTrack[];
		};
	};
	playabilityStatus?: { status?: string; reason?: string };
}

const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ANDROID_CLIENT_VERSION = "20.01.38";
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14) gzip`;

export async function fetchYoutubeSubtitle(
	videoId: string,
	config: Config,
	fetchImpl: typeof fetch = fetch,
): Promise<YoutubeExtraction> {
	const player = await fetchPlayerResponse(videoId, config.youtube.timeoutMs, fetchImpl);
	const details = player.videoDetails ?? {};
	const info: YoutubeVideoInfo = {
		videoId: details.videoId || videoId,
		title: details.title || "YouTube video",
		owner: details.author || "",
		durationSeconds: Number(details.lengthSeconds) || 0,
		description: details.shortDescription || "",
		coverUrl: largestThumbnail(details.thumbnail?.thumbnails ?? []),
	};

	const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
	if (!tracks.length) {
		const reason = youtubeNoCaptionReason(player);
		return { kind: "no-subtitle", info, reason };
	}

	const track = pickCaptionTrack(tracks, config.youtube.languages);
	if (!track?.baseUrl) return { kind: "no-subtitle", info, reason: "没有找到可读取的 YouTube 字幕地址。" };

	const cues = await fetchCaptionCues(track, config.youtube.timeoutMs, fetchImpl);
	if (!cues.lines.length) return { kind: "no-subtitle", info, reason: "YouTube 字幕轨存在，但内容为空。" };

	return {
		kind: "subtitle",
		info,
		lang: captionTrackLabel(track),
		lineCount: cues.lines.length,
		text: cues.lines.join("\n"),
	};
}

async function fetchPlayerResponse(
	videoId: string,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<YoutubePlayerResponse> {
	const androidResponse = await fetchAndroidPlayerResponse(videoId, timeoutMs, fetchImpl).catch(() => undefined);
	if (androidResponse?.videoDetails) return androidResponse;

	const html = await getText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=zh-CN`, timeoutMs, fetchImpl);
	const json = extractJsonAssignment(html, "ytInitialPlayerResponse");
	if (!json) {
		if (androidResponse) return androidResponse;
		throw new Error("没有在 YouTube 页面中找到公开视频信息。");
	}
	const browserResponse = JSON.parse(json) as YoutubePlayerResponse;
	if (browserResponse.videoDetails) return browserResponse;
	return androidResponse ?? browserResponse;
}

function youtubeNoCaptionReason(player: YoutubePlayerResponse) {
	const status = player.playabilityStatus?.status;
	const reason = player.playabilityStatus?.reason;
	if (status === "LOGIN_REQUIRED") {
		return `YouTube 要求登录验证${reason ? `：${reason}` : ""}`;
	}
	return reason || "这条 YouTube 视频没有公开字幕轨。";
}

async function fetchAndroidPlayerResponse(
	videoId: string,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<YoutubePlayerResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"User-Agent": ANDROID_USER_AGENT,
				"X-Youtube-Client-Name": "3",
				"X-Youtube-Client-Version": ANDROID_CLIENT_VERSION,
			},
			body: JSON.stringify({
				videoId,
				context: {
					client: {
						clientName: "ANDROID",
						clientVersion: ANDROID_CLIENT_VERSION,
						androidSdkVersion: 35,
						hl: "zh-CN",
						gl: "US",
						userAgent: ANDROID_USER_AGENT,
					},
				},
			}),
		});
		if (!response.ok) throw new Error(`YouTube InnerTube 返回 HTTP ${response.status}`);
		return (await response.json()) as YoutubePlayerResponse;
	} finally {
		clearTimeout(timer);
	}
}

function pickCaptionTrack(tracks: YoutubeCaptionTrack[], preferredLanguages: string[]) {
	return [...tracks].sort((left, right) => scoreTrack(right, preferredLanguages) - scoreTrack(left, preferredLanguages))[0];
}

function scoreTrack(track: YoutubeCaptionTrack, preferredLanguages: string[]) {
	const lang = normalizeLanguage(track.languageCode);
	const name = captionTrackName(track).toLowerCase();
	const index = preferredLanguages.findIndex((preferred) => languageMatches(lang, preferred, name));
	const preferredScore = index >= 0 ? 1000 - index * 50 : 0;
	const chineseScore = lang.startsWith("zh") || /中文|chinese/.test(name) ? 120 : 0;
	const englishScore = lang.startsWith("en") || /english/.test(name) ? 80 : 0;
	const manualScore = track.kind === "asr" || String(track.vssId ?? "").startsWith("a.") ? 0 : 20;
	return preferredScore + chineseScore + englishScore + manualScore;
}

function languageMatches(lang: string, preferred: string, name: string) {
	const target = normalizeLanguage(preferred);
	if (!target) return false;
	if (lang === target || lang.startsWith(`${target}-`) || target.startsWith(`${lang}-`)) return true;
	if (target.startsWith("zh")) return lang.startsWith("zh") || /中文|chinese/.test(name);
	if (target.startsWith("en")) return lang.startsWith("en") || /english/.test(name);
	return false;
}

async function fetchCaptionCues(
	track: YoutubeCaptionTrack,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<{ lines: string[]; endSeconds: number }> {
	const url = new URL(decodeHtml(String(track.baseUrl)));
	url.searchParams.set("fmt", "json3");
	const raw = await getText(url.toString(), timeoutMs, fetchImpl);
	try {
		const body = JSON.parse(raw) as Record<string, any>;
		const entries: Array<Record<string, any>> = Array.isArray(body.events) ? body.events : [];
		const lines = entries
			.map((entry) =>
				Array.isArray(entry.segs) ? entry.segs.map((seg) => String(seg.utf8 ?? "")).join("").replace(/\s+/g, " ").trim() : "",
			)
			.filter(Boolean);
		const endSeconds = entries.reduce(
			(latest, entry) => Math.max(latest, (Number(entry.tStartMs) + Number(entry.dDurationMs || 0)) / 1000 || 0),
			0,
		);
		return { lines, endSeconds };
	} catch {
		return parseXmlCaptions(raw);
	}
}

async function getText(url: string, timeoutMs: number, fetchImpl: typeof fetch) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": url.includes("/api/timedtext") ? ANDROID_USER_AGENT : BROWSER_USER_AGENT,
				"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
				Referer: "https://www.youtube.com",
			},
		});
		if (!response.ok) throw new Error(`YouTube 请求返回 HTTP ${response.status}: ${url}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

function extractJsonAssignment(html: string, variableName: string) {
	const index = html.indexOf(variableName);
	if (index < 0) return undefined;
	const start = html.indexOf("{", index);
	if (start < 0) return undefined;
	return readJsonObject(html, start);
}

function readJsonObject(text: string, start: number) {
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

function parseXmlCaptions(xml: string) {
	const lines: string[] = [];
	let endSeconds = 0;
	for (const match of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
		const attrs = match[1];
		const start = Number(attrs.match(/\bstart="([^"]+)"/)?.[1]) || 0;
		const duration = Number(attrs.match(/\bdur="([^"]+)"/)?.[1]) || 0;
		const line = decodeHtml(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
		if (line) lines.push(line);
		endSeconds = Math.max(endSeconds, start + duration);
	}
	return { lines, endSeconds };
}

function captionTrackLabel(track: YoutubeCaptionTrack) {
	const name = captionTrackName(track);
	const lang = track.languageCode ? ` ${track.languageCode}` : "";
	const auto = track.kind === "asr" || String(track.vssId ?? "").startsWith("a.") ? "自动字幕" : "字幕";
	return [name, lang, auto].filter(Boolean).join(" · ");
}

function captionTrackName(track: YoutubeCaptionTrack) {
	return track.name?.simpleText || track.name?.runs?.map((run) => run.text ?? "").join("") || "";
}

function largestThumbnail(thumbnails: Array<{ url?: string; width?: number; height?: number }>) {
	return [...thumbnails].sort((left, right) => (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0))[0]?.url ?? "";
}

function normalizeLanguage(value: string | undefined) {
	return String(value ?? "").toLowerCase().replace("_", "-");
}

function decodeHtml(text: string) {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}
