import assert from "node:assert/strict";
import test from "node:test";
import { isSafePublicUrl, sanitizePublicSearchQuery, searchWeb } from "../dist/webSearch.js";

test("sanitizePublicSearchQuery removes private identifiers and credentials", () => {
	const query = sanitizePublicSearchQuery(
		"帮测试有限公司的内部项目 Example 选服务 https://private.example/doc 10.0.0.8 " +
			"owner@example.com sk-abcdefghijklmnopqrstuvwxyz123456 ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	);
	assert.doesNotMatch(query, /测试有限公司/);
	assert.doesNotMatch(query, /https?:\/\//);
	assert.doesNotMatch(query, /10\.0\.0\.8/);
	assert.doesNotMatch(query, /owner@example\.com/);
	assert.doesNotMatch(query, /sk-/);
	assert.doesNotMatch(query, /ou_/);
});

test("searchWeb parses and deduplicates RSS results", async () => {
	const rss = `<?xml version="1.0"?><rss><channel>
		<item><title>Alpha &amp; API</title><link>https://example.com/a</link><description>First result</description></item>
		<item><title>Alpha duplicate</title><link>https://example.com/a</link><description>Duplicate</description></item>
		<item><title>Beta</title><link>https://example.com/b</link><description><![CDATA[<b>Second</b> result]]></description></item>
	</channel></rss>`;
	const config = {
		decision: {
			webSearchEnabled: true,
			webSearchProvider: "custom",
			webSearchApiKey: "",
			webSearchUrl: "https://search.example/?q={query}",
			webSearchTimeoutMs: 1000,
			maxSources: 5,
		},
	};
	const fetchImpl = async () => new Response(rss, { headers: { "content-type": "application/rss+xml" } });
	const results = await searchWeb("public query", config, fetchImpl);
	assert.equal(results.length, 2);
	assert.equal(results[0].title, "Alpha & API");
	assert.equal(results[1].snippet, "Second result");
});

test("isSafePublicUrl rejects local and private network targets", () => {
	assert.equal(isSafePublicUrl("http://127.0.0.1:8788/health"), false);
	assert.equal(isSafePublicUrl("http://192.168.1.10/admin"), false);
	assert.equal(isSafePublicUrl("http://localhost/internal"), false);
	assert.equal(isSafePublicUrl("https://example.com/public"), true);
});

test("searchWeb sends Brave authentication and reads web results", async () => {
	const braveConfig = {
		decision: {
			webSearchEnabled: true,
			webSearchProvider: "brave",
			webSearchApiKey: "test-key",
			webSearchUrl: "https://api.search.brave.com/res/v1/web/search?q={query}",
			webSearchTimeoutMs: 1000,
			maxSources: 5,
		},
	};
	const fetchImpl = async (_url, init) => {
		assert.equal(init.headers["X-Subscription-Token"], "test-key");
		return new Response(
			JSON.stringify({ web: { results: [{ title: "Official docs", url: "https://example.com/docs", description: "API reference" }] } }),
			{ headers: { "content-type": "application/json" } },
		);
	};
	const results = await searchWeb("API service", braveConfig, fetchImpl);
	assert.deepEqual(results, [{ title: "Official docs", url: "https://example.com/docs", snippet: "API reference" }]);
});

test("searchWeb can use Monid as the web search provider", async () => {
	const monidConfig = {
		decision: {
			webSearchEnabled: true,
			webSearchProvider: "monid",
			webSearchApiKey: "test-key",
			webSearchUrl: "",
			webSearchTimeoutMs: 1000,
			maxSources: 5,
			monidBaseUrl: "https://api.monid.test",
			monidProvider: "context.dev",
			monidEndpoint: "/web/search",
		},
	};
	const fetchImpl = async () =>
		new Response(
			JSON.stringify({
				status: "COMPLETED",
				output: {
					results: [{ title: "Monid result", url: "https://example.com/monid", description: "Search result" }],
				},
				providerResponse: { httpStatus: 200 },
			}),
			{ headers: { "content-type": "application/json" } },
		);
	const results = await searchWeb("API service", monidConfig, fetchImpl);
	assert.deepEqual(results, [{ title: "Monid result", url: "https://example.com/monid", snippet: "Search result" }]);
});
