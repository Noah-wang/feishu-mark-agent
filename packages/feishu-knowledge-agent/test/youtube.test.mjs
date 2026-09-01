import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYoutubeVideoId } from "../dist/url.js";
import { fetchYoutubeSubtitle } from "../dist/youtube.js";

const config = {
	youtube: {
		languages: ["zh-Hans", "zh-CN", "zh", "en"],
		timeoutMs: 1000,
	},
};

test("parseYoutubeVideoId supports common YouTube URL forms", () => {
	assert.equal(parseYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.equal(parseYoutubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc"), "dQw4w9WgXcQ");
	assert.equal(parseYoutubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.equal(parseYoutubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("fetchYoutubeSubtitle reads preferred caption tracks", async () => {
	const playerResponse = {
		videoDetails: {
			videoId: "dQw4w9WgXcQ",
			title: "Example Video",
			author: "Example Channel",
			lengthSeconds: "120",
			shortDescription: "Example description",
			thumbnail: {
				thumbnails: [
					{ url: "https://img.example/small.jpg", width: 120, height: 90 },
					{ url: "https://img.example/large.jpg", width: 480, height: 360 },
				],
			},
		},
		captions: {
			playerCaptionsTracklistRenderer: {
				captionTracks: [
					{
						baseUrl: "https://caption.example/timedtext?lang=en",
						languageCode: "en",
						name: { simpleText: "English" },
					},
					{
						baseUrl: "https://caption.example/timedtext?lang=zh-Hans",
						languageCode: "zh-Hans",
						kind: "asr",
						name: { simpleText: "中文（自动生成）" },
					},
				],
			},
		},
	};
	const captionResponse = {
		events: [
			{ tStartMs: 0, dDurationMs: 1400, segs: [{ utf8: "第一句" }] },
			{ tStartMs: 1500, dDurationMs: 1400, segs: [{ utf8: "第二句" }] },
		],
	};
	const seen = [];
	const fetchImpl = async (url) => {
		seen.push(url);
		if (String(url).includes("/youtubei/v1/player")) {
			return new Response(JSON.stringify(playerResponse), { headers: { "content-type": "application/json" } });
		}
		return new Response(JSON.stringify(captionResponse), { headers: { "content-type": "application/json" } });
	};

	const extraction = await fetchYoutubeSubtitle("dQw4w9WgXcQ", config, fetchImpl);

	assert.equal(extraction.kind, "subtitle");
	assert.equal(extraction.info.title, "Example Video");
	assert.equal(extraction.info.owner, "Example Channel");
	assert.equal(extraction.info.coverUrl, "https://img.example/large.jpg");
	assert.match(extraction.lang, /zh-Hans/);
	assert.equal(extraction.lineCount, 2);
	assert.equal(extraction.text, "第一句\n第二句");
	assert.equal(new URL(seen[1]).searchParams.get("fmt"), "json3");
});

test("fetchYoutubeSubtitle returns metadata when no captions are public", async () => {
	const playerResponse = {
		videoDetails: {
			videoId: "dQw4w9WgXcQ",
			title: "No Caption Video",
			author: "Example Channel",
			lengthSeconds: "60",
			shortDescription: "Only metadata",
		},
		playabilityStatus: { status: "OK" },
	};
	const fetchImpl = async () => new Response(JSON.stringify(playerResponse), { headers: { "content-type": "application/json" } });

	const extraction = await fetchYoutubeSubtitle("dQw4w9WgXcQ", config, fetchImpl);

	assert.equal(extraction.kind, "no-subtitle");
	assert.equal(extraction.info.title, "No Caption Video");
	assert.match(extraction.reason, /没有公开字幕轨/);
});

test("fetchYoutubeSubtitle surfaces YouTube login checks", async () => {
	const playerResponse = {
		playabilityStatus: {
			status: "LOGIN_REQUIRED",
			reason: "请登录，以便我们确认你不是聊天机器人",
		},
	};
	const fetchImpl = async (url) => {
		if (String(url).includes("/youtubei/v1/player")) {
			return new Response(JSON.stringify(playerResponse), { headers: { "content-type": "application/json" } });
		}
		return new Response("window.ytInitialPlayerResponse = {}; </script>");
	};

	const extraction = await fetchYoutubeSubtitle("dQw4w9WgXcQ", config, fetchImpl);

	assert.equal(extraction.kind, "no-subtitle");
	assert.equal(extraction.info.title, "YouTube video");
	assert.match(extraction.reason, /登录验证/);
});
