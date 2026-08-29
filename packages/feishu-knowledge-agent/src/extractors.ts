import { spawn } from "node:child_process";
import { type BilibiliVideoInfo, fetchBilibiliSubtitle } from "./bilibili.js";
import type { Config } from "./config.js";
import type { ExtractedContent } from "./types.js";
import { classifyUrl, parseBilibiliId, parseGithubRepo, parseTweetId } from "./url.js";

export async function extractContent(url: string, config: Config): Promise<ExtractedContent> {
	const sourceType = classifyUrl(url);
	if (sourceType === "x") return extractXPost(url, config);
	if (sourceType === "github") return extractGithub(url);
	if (sourceType === "bilibili" || sourceType === "video") return extractBilibiliOrVideo(url, config);
	return extractArticle(url);
}

async function extractXPost(url: string, config: Config): Promise<ExtractedContent> {
	const tweetId = parseTweetId(url);
	if (tweetId && config.xBearerToken) {
		const apiUrl = new URL(`https://api.x.com/2/tweets/${tweetId}`);
		apiUrl.searchParams.set("tweet.fields", "created_at,public_metrics,entities,attachments");
		apiUrl.searchParams.set("expansions", "author_id,attachments.media_keys");
		apiUrl.searchParams.set("user.fields", "name,username,verified");
		apiUrl.searchParams.set("media.fields", "type,url,preview_image_url,alt_text");

		const response = await fetch(apiUrl, {
			headers: { Authorization: `Bearer ${config.xBearerToken}` },
		});
		if (response.ok) {
			const body = (await response.json()) as any;
			const post = body.data;
			const author = body.includes?.users?.[0];
			const media = body.includes?.media ?? [];
			const images = media.map((item: any) => item.url ?? item.preview_image_url).filter(Boolean);
			return {
				url,
				sourceType: "x",
				title: author?.username ? `X post by @${author.username}` : "X post",
				text: post?.text ?? "",
				images,
				metadata: { tweetId, author, metrics: post?.public_metrics, createdAt: post?.created_at, media },
			};
		}
	}

	const article = await extractArticle(url);
	return {
		...article,
		sourceType: "x",
		metadata: { ...article.metadata, tweetId, extractionWarning: "Set X_BEARER_TOKEN for reliable X extraction." },
	};
}

async function extractGithub(url: string): Promise<ExtractedContent> {
	const repo = parseGithubRepo(url);
	if (!repo) return extractArticle(url);

	const headers = { "User-Agent": "myPiAgent-feishu-knowledge-agent" };
	const [repoRes, readmeRes] = await Promise.all([
		fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, { headers }),
		fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/README.md`, { headers }),
	]);
	const repoJson = repoRes.ok ? ((await repoRes.json()) as any) : {};
	const readme = readmeRes.ok ? await readmeRes.text() : "";
	return {
		url,
		sourceType: "github",
		title: repoJson.full_name ?? `${repo.owner}/${repo.repo}`,
		text: [repoJson.description, readme].filter(Boolean).join("\n\n").slice(0, 40000),
		images: [],
		metadata: {
			owner: repo.owner,
			repo: repo.repo,
			stars: repoJson.stargazers_count,
			forks: repoJson.forks_count,
			language: repoJson.language,
			license: repoJson.license?.spdx_id,
			updatedAt: repoJson.updated_at,
		},
	};
}

async function extractBilibiliOrVideo(url: string, config: Config): Promise<ExtractedContent> {
	if (config.bilibili.transcriptCommand) {
		const output = await runShellTemplate(config.bilibili.transcriptCommand, url, process.cwd(), 180000);
		const parsed = JSON.parse(output);
		return {
			url,
			sourceType: "bilibili",
			title: parsed.title ?? "Bilibili video",
			text: parsed.text ?? parsed.transcript ?? "",
			images: parsed.images ?? [],
			metadata: { ...(parsed.metadata ?? {}), videoId: parseBilibiliId(url), extractor: "custom-bilibili-command" },
		};
	}

	const videoId = await resolveBilibiliVideoId(url);
	if (!videoId) {
		return bilibiliPageFallback(
			url,
			"链接里没有可识别的 BV/AV 号，请发送完整的 bilibili.com/video 链接。",
			undefined,
		);
	}

	const extraction = await fetchBilibiliSubtitle(videoId, config).catch((error) => error as Error);
	if (extraction instanceof Error) {
		return bilibiliPageFallback(url, extraction.message, videoId);
	}

	const { info } = extraction;
	const baseMetadata = {
		videoId: info.videoId,
		owner: info.owner,
		durationSeconds: info.durationSeconds,
		partCount: info.partCount,
	};

	if (extraction.kind === "subtitle") {
		return {
			url,
			sourceType: "bilibili",
			title: info.title,
			text: withPartOnlyNotice(info, extraction.text),
			images: [],
			metadata: {
				...baseMetadata,
				extractor: "bilibili-subtitle-api",
				subtitleLang: extraction.lang,
				subtitleLines: extraction.lineCount,
			},
		};
	}

	// The video page is behind anti-bot checks for some videos and returns a 252-byte
	// error page, so build the fallback from the API metadata we already hold.
	return {
		url,
		sourceType: "bilibili",
		title: info.title,
		text: withNoSubtitleNotice(extraction.reason, describeVideo(info)),
		images: [],
		metadata: {
			...baseMetadata,
			extractor: "bilibili-metadata-fallback",
			extractionWarning: extraction.reason,
		},
	};
}

/** Only the first part is transcribed, so a collection's summary must not claim to cover all of it. */
function withPartOnlyNotice(info: BilibiliVideoInfo, text: string) {
	if (info.partCount <= 1) return text;
	return `【内容来源说明】这是一个 ${info.partCount} 个分P的合集，以下字幕只来自第 1 个分P（约 ${Math.round(info.transcribedSeconds / 60)} 分钟），不代表整个合集。摘要中要说明这一点。\n\n${text}`;
}

function describeVideo(info: BilibiliVideoInfo) {
	return [
		`标题：${info.title}`,
		`UP 主：${info.owner || "未知"}`,
		`时长：${Math.round(info.durationSeconds / 60)} 分钟`,
		"",
		"视频简介：",
		info.description || "（这个视频没有填写简介）",
	].join("\n");
}

async function bilibiliPageFallback(
	url: string,
	reason: string,
	videoId: string | undefined,
): Promise<ExtractedContent> {
	const article = await extractArticle(url);
	return {
		...article,
		sourceType: "bilibili",
		text: withNoSubtitleNotice(reason, article.text),
		metadata: {
			...article.metadata,
			videoId: videoId ?? parseBilibiliId(url),
			extractor: "bilibili-page-fallback",
			extractionWarning: reason,
		},
	};
}

/**
 * Without this marker the model sees `Source type: bilibili` plus some text and
 * describes it as if it had read the subtitles, inventing what the video says.
 */
function withNoSubtitleNotice(reason: string, text: string) {
	return `【内容来源说明】没有拿到这个视频的字幕，原因：${reason}\n以下只是视频的标题、简介等外围信息，不是视频里实际说的话。请勿据此推测视频讲了什么，摘要中要说明这一限制。\n\n${text}`;
}

async function resolveBilibiliVideoId(url: string): Promise<string | undefined> {
	const direct = parseBilibiliId(url);
	if (direct) return direct;
	try {
		const response = await fetch(url, {
			redirect: "follow",
			headers: { "User-Agent": "myPiAgent-feishu-knowledge-agent" },
		});
		return parseBilibiliId(response.url);
	} catch {
		return undefined;
	}
}

async function extractArticle(url: string): Promise<ExtractedContent> {
	const response = await fetch(url, { headers: { "User-Agent": "myPiAgent-feishu-knowledge-agent" } });
	const html = await response.text();
	const title = pickMeta(html, "og:title") ?? pickTag(html, "title") ?? url;
	const description = pickMeta(html, "description") ?? pickMeta(html, "og:description") ?? "";
	const image = pickMeta(html, "og:image");
	return {
		url,
		sourceType: classifyUrl(url),
		title: decodeHtml(title),
		text: decodeHtml(`${description}\n\n${stripHtml(html)}`).slice(0, 40000),
		images: image ? [image] : [],
		metadata: { status: response.status, contentType: response.headers.get("content-type") },
	};
}

function pickMeta(html: string, name: string) {
	const pattern = new RegExp(
		`<meta[^>]+(?:property|name)=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
		"i",
	);
	return html.match(pattern)?.[1];
}

function pickTag(html: string, tag: string) {
	return html.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "is"))?.[1]?.trim();
}

function stripHtml(html: string) {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(text: string) {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runShellTemplate(template: string, url: string, cwd: string, timeoutMs: number) {
	const command = template.replaceAll("{url}", JSON.stringify(url).slice(1, -1));
	return runCommand(process.env.SHELL ?? "/bin/sh", ["-lc", command], cwd, timeoutMs);
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv } });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Command timed out: ${command}`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Command failed with exit code ${code}`));
		});
	});
}
