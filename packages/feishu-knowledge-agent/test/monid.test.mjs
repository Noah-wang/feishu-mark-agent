import assert from "node:assert/strict";
import { test } from "node:test";
import { searchMonidWeb } from "../dist/monid.js";

const baseConfig = {
	decision: {
		webSearchApiKey: "test-key",
		webSearchTimeoutMs: 5000,
		maxSources: 5,
		monidBaseUrl: "https://api.monid.test/",
		monidProvider: "context.dev",
		monidEndpoint: "/web/search",
	},
};

test("searchMonidWeb sends search request and parses results", async () => {
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
					results: [
						{
							title: "Example page",
							url: "https://example.com/page",
							description: "Useful search result",
						},
					],
				},
				price: { amount: 0.0009, currency: "USD" },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const results = await searchMonidWeb("AI search tools", baseConfig, fetchImpl);

	assert.equal(seenRequest.url, "https://api.monid.test/v1/run");
	assert.equal(seenRequest.headers.Authorization, "Bearer test-key");
	assert.equal(seenRequest.body.provider, "context.dev");
	assert.equal(seenRequest.body.endpoint, "/web/search");
	assert.equal(seenRequest.body.input.body.query, "AI search tools");
	assert.equal(seenRequest.body.input.body.numResults, 10);
	assert.equal(seenRequest.body.input.body.markdownOptions.enabled, false);
	assert.deepEqual(results, [
		{
			title: "Example page",
			url: "https://example.com/page",
			snippet: "Useful search result",
		},
	]);
});

test("searchMonidWeb requires an API key", async () => {
	await assert.rejects(
		searchMonidWeb("AI search tools", {
			decision: {
				...baseConfig.decision,
				webSearchApiKey: "",
			},
		}),
		/MONID_API_KEY/,
	);
});
