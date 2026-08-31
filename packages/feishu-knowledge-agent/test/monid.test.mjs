import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchMonidPage } from "../dist/monid.js";

const baseConfig = {
	monid: {
		apiKey: "test-key",
		baseUrl: "https://api.monid.test/",
		provider: "context.dev",
		endpoint: "/web/scrape/markdown",
		maxAgeMs: 0,
		waitForMs: 3000,
		timeoutMs: 5000,
	},
};

test("fetchMonidPage sends scrape request and parses markdown", async () => {
	let seenRequest;
	const fetchImpl = async (url, options) => {
		seenRequest = {
			url,
			headers: options.headers,
			body: JSON.parse(options.body),
		};
		return new Response(
			JSON.stringify({
				status: "COMPLETED",
				output: {
					markdown: "# Example\n\nUseful content",
					metadata: { title: "Example page", image: "https://example.com/card.jpg" },
				},
				price: { amount: 0.0009, currency: "USD" },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const page = await fetchMonidPage("https://x.com/example/status/1", baseConfig, fetchImpl);

	assert.equal(seenRequest.url, "https://api.monid.test/v1/run");
	assert.equal(seenRequest.headers.Authorization, "Bearer test-key");
	assert.equal(seenRequest.body.provider, "context.dev");
	assert.equal(seenRequest.body.endpoint, "/web/scrape/markdown");
	assert.equal(seenRequest.body.input.queryParams.url, "https://x.com/example/status/1");
	assert.equal(seenRequest.body.input.queryParams.includeLinks, true);
	assert.equal(seenRequest.body.input.queryParams.includeImages, true);
	assert.equal(page.markdown, "# Example\n\nUseful content");
	assert.equal(page.metadata.title, "Example page");
	assert.deepEqual(page.price, { amount: 0.0009, currency: "USD" });
});

test("fetchMonidPage requires an API key", async () => {
	await assert.rejects(
		fetchMonidPage("https://example.com", { monid: { ...baseConfig.monid, apiKey: "" } }),
		/MONID_API_KEY/,
	);
});
