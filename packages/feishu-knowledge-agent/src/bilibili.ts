/**
 * Bilibili subtitle extraction against the public web APIs.
 *
 * This replaced a vendored Python script driven through `subprocess`. That design
 * located its output by scanning the output directory for the newest `.txt`, so a
 * video without subtitles silently picked up the previously fetched video's
 * transcript. Returning the text directly removes that whole class of bug, and
 * drops the Python, venv, and dependency-install requirements from deployment.
 */

import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";

export interface BilibiliVideoInfo {
	videoId: string;
	title: string;
	owner: string;
	/** Total length of every part, which is what the video page shows. */
	durationSeconds: number;
	/** Only the first part is transcribed, so this is the length the subtitle covers. */
	transcribedSeconds: number;
	partCount: number;
	description: string;
}

/**
 * Subtitles are frequently unavailable, so this is a result rather than an
 * exception: the caller still gets the video metadata to archive something
 * honest instead of falling back to scraping the page.
 */
export type BilibiliExtraction =
	| { kind: "subtitle"; info: BilibiliVideoInfo; lang: string; lineCount: number; text: string }
	| { kind: "no-subtitle"; info: BilibiliVideoInfo; reason: string };

interface BilibiliCredential {
	sessdata: string;
	biliJct: string;
	buvid3: string;
}

interface SubtitleTrack {
	lan?: string;
	lan_doc?: string;
	subtitle_url?: string;
}

interface RawVideoInfo {
	aid: number;
	cid: number;
	bvid: string;
	title: string;
	duration: number;
	desc?: string;
	owner?: { name?: string };
	pages?: Array<{ cid: number; duration: number }>;
}

const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * Bilibili sometimes answers with a Chinese track whose content belongs to an
 * unrelated video, and the garbage differs from request to request. Eight
 * consecutive fetches for BV1nB3u6tERu (278 min) returned three empty track
 * lists and five different transcripts — prison drama, a celebrity segment,
 * nineteen lines of "♪ 音乐 ♪" — at 0.1 to 2.2 lines per minute.
 *
 * Across roughly 30 verified-genuine transcripts the rate never fell below 18
 * lines per minute, so 10 leaves headroom on both sides.
 */
const MIN_LINES_PER_MINUTE = 10;

/**
 * Density alone would accept a dense transcript borrowed from a shorter video.
 * A genuine track runs to roughly the end of the part it belongs to, so require
 * the last cue to land in the second half.
 */
const MIN_TIMELINE_COVERAGE = 0.5;

export async function fetchBilibiliSubtitle(videoId: string, config: Config): Promise<BilibiliExtraction> {
	const credential = await loadCredential(config);
	const headers = requestHeaders(credential);
	const timeoutMs = config.bilibili.timeoutMs;

	const raw = await fetchVideoInfo(videoId, headers, timeoutMs);
	// `duration` covers every part, but the subtitle we fetch belongs to `cid`, which is
	// the first part. Dividing by the total would reject a valid 7-minute transcript on a
	// 60-part collection as "too sparse".
	const parts = Array.isArray(raw.pages) ? raw.pages : [];
	const transcribedPart = parts.find((page) => page.cid === raw.cid) ?? parts[0];
	const info: BilibiliVideoInfo = {
		videoId: raw.bvid,
		title: raw.title,
		owner: raw.owner?.name ?? "",
		durationSeconds: raw.duration,
		transcribedSeconds: transcribedPart?.duration || raw.duration,
		partCount: parts.length || 1,
		description: raw.desc ?? "",
	};

	const tracks = chineseTracks(await fetchSubtitleTracks(raw, headers, timeoutMs));
	if (!tracks.length) {
		return { kind: "no-subtitle", info, reason: "这条视频没有中文字幕轨（含 AI 字幕）。" };
	}

	const rejected: string[] = [];
	for (const track of tracks) {
		const lang = track.lan_doc || track.lan || "中文";
		const cues = await fetchSubtitleCues(track, headers, timeoutMs);
		if (!cues.lines.length) {
			rejected.push(`${lang} 轨内容为空`);
			continue;
		}

		const minutes = info.transcribedSeconds / 60;
		if (minutes > 0) {
			const density = cues.lines.length / minutes;
			if (density < MIN_LINES_PER_MINUTE) {
				rejected.push(
					`${lang} 轨字幕密度异常（${cues.lines.length} 行 / ${Math.round(minutes)} 分钟 = ${density.toFixed(1)} 行每分钟），内容大概率不属于这个视频，已丢弃`,
				);
				continue;
			}
			const coverage = cues.endSeconds / info.transcribedSeconds;
			if (coverage < MIN_TIMELINE_COVERAGE) {
				rejected.push(
					`${lang} 轨时间轴只覆盖到 ${Math.round(coverage * 100)}%（最后一句在第 ${Math.round(cues.endSeconds / 60)} 分钟，视频有 ${Math.round(minutes)} 分钟），内容大概率不属于这个视频，已丢弃`,
				);
				continue;
			}
		}

		return { kind: "subtitle", info, lang, lineCount: cues.lines.length, text: cues.lines.join("\n") };
	}

	return { kind: "no-subtitle", info, reason: `字幕轨存在但不可用：${rejected.join("；")}` };
}

async function loadCredential(config: Config): Promise<BilibiliCredential> {
	const fromEnv = config.bilibili.credential;
	if (fromEnv.sessdata) return fromEnv;

	const raw = await readFile(config.bilibili.configFile, "utf8").catch(() => undefined);
	if (raw === undefined) {
		throw new Error(
			`缺少 B 站登录凭据。请设置 BILIBILI_SESSDATA，或提供 ${config.bilibili.configFile}（含 sessdata、bili_jct、buvid3）。`,
		);
	}
	const parsed = JSON.parse(raw) as Record<string, string>;
	const sessdata = parsed.sessdata ?? "";
	if (!sessdata) {
		throw new Error(`${config.bilibili.configFile} 里没有 sessdata。`);
	}
	return { sessdata, biliJct: parsed.bili_jct ?? "", buvid3: parsed.buvid3 ?? parsed.buvid ?? "" };
}

function requestHeaders(credential: BilibiliCredential): Record<string, string> {
	return {
		"User-Agent": BROWSER_USER_AGENT,
		Referer: "https://www.bilibili.com",
		Cookie: `SESSDATA=${credential.sessdata}; BILI_JCT=${credential.biliJct}; buvid3=${credential.buvid3}`,
	};
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Record<string, any>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`B 站接口返回 HTTP ${response.status}: ${url}`);
		return (await response.json()) as Record<string, any>;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchVideoInfo(
	videoId: string,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<RawVideoInfo> {
	const query = /^BV/i.test(videoId) ? `bvid=${videoId}` : `aid=${videoId}`;
	const body = await getJson(`https://api.bilibili.com/x/web-interface/view?${query}`, headers, timeoutMs);
	if (body.code !== 0) {
		throw new Error(`读取视频信息失败（${videoId}）：${body.message ?? body.code}`);
	}
	return body.data as RawVideoInfo;
}

/**
 * Both endpoints are needed: `wbi/v2` is current but returns an empty track list
 * for some videos that the legacy `player/v2` still answers.
 */
async function fetchSubtitleTracks(
	info: RawVideoInfo,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<SubtitleTrack[]> {
	const primary = await getJson(
		`https://api.bilibili.com/x/player/wbi/v2?aid=${info.aid}&cid=${info.cid}&bvid=${info.bvid}`,
		headers,
		timeoutMs,
	).catch(() => undefined);
	const primaryTracks = primary?.code === 0 ? subtitlesOf(primary) : [];
	if (primaryTracks.length) return primaryTracks;

	const fallback = await getJson(
		`https://api.bilibili.com/x/player/v2?bvid=${info.bvid}&cid=${info.cid}`,
		headers,
		timeoutMs,
	).catch(() => undefined);
	return fallback?.code === 0 ? subtitlesOf(fallback) : [];
}

function subtitlesOf(body: Record<string, any>): SubtitleTrack[] {
	const tracks = body.data?.subtitle?.subtitles;
	return Array.isArray(tracks) ? (tracks as SubtitleTrack[]) : [];
}

/** AI subtitles use lan `ai-zh` and their lan_doc does not always contain 中文. */
function chineseTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
	return tracks.filter(
		(track) => String(track.lan_doc ?? "").includes("中文") || String(track.lan ?? "").startsWith("ai-zh"),
	);
}

async function fetchSubtitleCues(
	track: SubtitleTrack,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<{ lines: string[]; endSeconds: number }> {
	let url = String(track.subtitle_url ?? "");
	if (!url) return { lines: [], endSeconds: 0 };
	if (url.startsWith("//")) url = `https:${url}`;
	const body = await getJson(url, headers, timeoutMs).catch(() => undefined);
	const entries: Array<Record<string, any>> = Array.isArray(body?.body) ? body.body : [];
	const lines = entries.map((entry) => String(entry.content ?? "").trim()).filter(Boolean);
	const endSeconds = entries.reduce((latest, entry) => Math.max(latest, Number(entry.to) || 0), 0);
	return { lines, endSeconds };
}
