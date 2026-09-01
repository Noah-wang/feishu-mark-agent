import type { Config } from "./config.js";
import type { WebSearchResult } from "./webSearch.js";

type FetchLike = typeof fetch;

type MonidRunResponse = {
	id?: string;
	runId?: string;
	status?: string;
	output?: {
		results?: unknown;
	};
	providerResponse?: { httpStatus?: unknown; error?: unknown };
	error?: unknown;
	price?: unknown;
};

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

export async function searchMonidWeb(
	query: string,
	config: Config,
	fetchImpl: FetchLike = fetch,
): Promise<WebSearchResult[]> {
	if (!config.decision.webSearchApiKey) throw new Error("Monid search needs MONID_API_KEY");

	const baseUrl = config.decision.monidBaseUrl.replace(/\/+$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.decision.webSearchTimeoutMs);
	try {
		const response = await fetchImpl(`${baseUrl}/v1/run`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.decision.webSearchApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: config.decision.monidProvider,
				endpoint: config.decision.monidEndpoint,
				input: {
					body: {
						query,
						numResults: clamp(config.decision.maxSources * 2, 10, 20),
						markdownOptions: { enabled: false },
					},
				},
			}),
			signal: controller.signal,
		});

		if (!response.ok && response.status !== 202) {
			throw new Error(`Monid request failed: HTTP ${response.status} ${await response.text()}`);
		}

		const body = (await response.json()) as MonidRunResponse;
		const finalBody =
			response.status === 202 ? await pollMonidRun(baseUrl, body, config, fetchImpl, controller.signal) : body;
		return parseMonidResults(finalBody);
	} finally {
		clearTimeout(timer);
	}
}

async function pollMonidRun(
	baseUrl: string,
	body: MonidRunResponse,
	config: Config,
	fetchImpl: FetchLike,
	signal: AbortSignal,
): Promise<MonidRunResponse> {
	const runId = body.id ?? body.runId;
	if (!runId) throw new Error("Monid async response did not include a run id");

	let current = body;
	while (!TERMINAL_STATUSES.has(String(current.status ?? "").toUpperCase())) {
		await delay(1000);
		const response = await fetchImpl(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
			headers: { Authorization: `Bearer ${config.decision.webSearchApiKey}` },
			signal,
		});
		if (!response.ok) throw new Error(`Monid run poll failed: HTTP ${response.status} ${await response.text()}`);
		current = (await response.json()) as MonidRunResponse;
	}

	return current;
}

function parseMonidResults(body: MonidRunResponse): WebSearchResult[] {
	if (String(body.status ?? "COMPLETED").toUpperCase() !== "COMPLETED") {
		throw new Error(`Monid run did not complete: ${body.status ?? "unknown"}`);
	}
	const providerStatus = Number(body.providerResponse?.httpStatus ?? 200);
	if (providerStatus >= 400) throw new Error(`Monid provider failed: HTTP ${providerStatus}`);
	const raw = Array.isArray(body.output?.results) ? body.output.results : [];
	return raw
		.map((item) => {
			const value = (item ?? {}) as Record<string, unknown>;
			return {
				title: String(value.title ?? "").trim(),
				url: String(value.url ?? "").trim(),
				snippet: String(value.description ?? value.snippet ?? value.content ?? "").trim(),
			};
		})
		.filter((result) => result.title && result.url);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(maximum, Math.max(minimum, value));
}
