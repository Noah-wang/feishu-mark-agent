import type { Config } from "./config.js";

export interface MonidPage {
	markdown: string;
	metadata: Record<string, unknown>;
	price?: unknown;
}

type FetchLike = typeof fetch;

type MonidRunResponse = {
	id?: string;
	runId?: string;
	status?: string;
	output?: {
		markdown?: unknown;
		metadata?: unknown;
	};
	error?: unknown;
	price?: unknown;
};

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

export async function fetchMonidPage(url: string, config: Config, fetchImpl: FetchLike = fetch): Promise<MonidPage> {
	if (!config.monid.apiKey) throw new Error("Monid needs MONID_API_KEY");

	const baseUrl = config.monid.baseUrl.replace(/\/+$/, "");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.monid.timeoutMs);
	try {
		const response = await fetchImpl(`${baseUrl}/v1/run`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.monid.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: config.monid.provider,
				endpoint: config.monid.endpoint,
				input: {
					queryParams: {
						url,
						includeLinks: true,
						includeImages: true,
						useMainContentOnly: true,
						maxAgeMs: config.monid.maxAgeMs,
						waitForMs: config.monid.waitForMs,
					},
				},
			}),
			signal: controller.signal,
		});

		if (!response.ok && response.status !== 202) {
			throw new Error(`Monid request failed: HTTP ${response.status} ${await response.text()}`);
		}

		const body = (await response.json()) as MonidRunResponse;
		const finalBody = response.status === 202 ? await pollMonidRun(baseUrl, body, config, fetchImpl, controller.signal) : body;
		return parseMonidPage(finalBody);
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
		await delay(Math.min(2000, Math.max(250, config.monid.waitForMs || 1000)));
		const response = await fetchImpl(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
			headers: { Authorization: `Bearer ${config.monid.apiKey}` },
			signal,
		});
		if (!response.ok) throw new Error(`Monid run poll failed: HTTP ${response.status} ${await response.text()}`);
		current = (await response.json()) as MonidRunResponse;
	}

	return current;
}

function parseMonidPage(body: MonidRunResponse): MonidPage {
	if (String(body.status ?? "COMPLETED").toUpperCase() !== "COMPLETED") {
		throw new Error(`Monid run did not complete: ${body.status ?? "unknown"}`);
	}
	const markdown = typeof body.output?.markdown === "string" ? body.output.markdown.trim() : "";
	if (!markdown) throw new Error("Monid returned empty markdown");
	const metadata = isRecord(body.output?.metadata) ? body.output.metadata : {};
	return { markdown, metadata, price: body.price };
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
