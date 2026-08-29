import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface TencentCloudCvmTarget {
	region: string;
	instanceId: string;
	alias: string;
}

export interface Config {
	port: number;
	publicBaseUrl: string;
	feishu: {
		appId: string;
		appSecret: string;
		verificationToken: string;
		encryptKey: string;
		bitableAppToken: string;
		bitableTableId: string;
		docId: string;
		docUrl: string;
		docFolderToken: string;
		fields: Record<string, string>;
	};
	pi: {
		binary: string;
		timeoutMs: number;
	};
	llm: {
		baseUrl: string;
		apiKey: string;
		model: string;
		timeoutMs: number;
	};
	bilibili: {
		transcriptCommand: string;
		configFile: string;
		credential: { sessdata: string; biliJct: string; buvid3: string };
		timeoutMs: number;
	};
	tencentCloud: {
		secretId: string;
		secretKey: string;
		securityToken: string;
		region: string;
		instanceId: string;
		instances: TencentCloudCvmTarget[];
		monitorNamespace: string;
		monitorDimensionName: string;
		monitorMetrics: string[];
		monitorPeriod: number;
		monitorWindowMinutes: number;
		timeoutMs: number;
	};
	xBearerToken: string;
	dataDir: string;
}

function env(name: string, fallback = "") {
	return process.env[name]?.trim() || fallback;
}

function envInt(name: string, fallback: number) {
	const value = Number.parseInt(env(name), 10);
	return Number.isFinite(value) ? value : fallback;
}

export async function loadConfig(): Promise<Config> {
	loadDotEnv(resolve(PACKAGE_DIR, ".env"));
	const dataDir = resolve(env("KNOWLEDGE_DATA_DIR", ".knowledge"));
	await mkdir(dataDir, { recursive: true });

	return {
		port: envInt("PORT", 8788),
		publicBaseUrl: env("PUBLIC_BASE_URL"),
		feishu: {
			appId: env("FEISHU_APP_ID"),
			appSecret: env("FEISHU_APP_SECRET"),
			verificationToken: env("FEISHU_VERIFICATION_TOKEN"),
			encryptKey: env("FEISHU_ENCRYPT_KEY"),
			bitableAppToken: env("FEISHU_BITABLE_APP_TOKEN"),
			bitableTableId: env("FEISHU_BITABLE_TABLE_ID"),
			docId: env("FEISHU_DOC_ID"),
			docUrl: env("FEISHU_DOC_URL"),
			docFolderToken: env("FEISHU_DOC_FOLDER_TOKEN"),
			fields: {
				title: env("FEISHU_FIELD_TITLE", "Title"),
				summary: env("FEISHU_FIELD_SUMMARY", "Summary"),
				category: env("FEISHU_FIELD_CATEGORY", "Category"),
				tags: env("FEISHU_FIELD_TAGS", "Tags"),
				sourceUrl: env("FEISHU_FIELD_SOURCE_URL", "Source URL"),
				sourceType: env("FEISHU_FIELD_SOURCE_TYPE", "Source Type"),
				useCases: env("FEISHU_FIELD_USE_CASES", "Use Cases"),
				sharer: env("FEISHU_FIELD_SHARER", "Sharer"),
				createdAt: env("FEISHU_FIELD_CREATED_AT", "Created At"),
			},
		},
		pi: {
			binary: env("PI_AGENT_BINARY", "pi"),
			timeoutMs: envInt("PI_AGENT_TIMEOUT_MS", 120000),
		},
		llm: {
			baseUrl: env("MARK_LLM_BASE_URL", env("THIRDPARTY_LLM_BASE_URL", env("ARK_BASE_URL", env("DOUBAO_API_URL")))),
			apiKey: env("MARK_LLM_API_KEY", env("THIRDPARTY_LLM_API_KEY", env("ARK_API_KEY", env("DOUBAO_API_KEY")))),
			model: env("MARK_LLM_MODEL", env("THIRDPARTY_LLM_MODEL", env("ARK_MODEL", env("DOUBAO_TEXT_MODEL_ID")))),
			timeoutMs: envInt("MARK_LLM_TIMEOUT_MS", 120000),
		},
		bilibili: {
			transcriptCommand: env("BILIBILI_TRANSCRIPT_COMMAND"),
			configFile: resolve(env("BILIBILI_CONFIG_FILE", resolve(PACKAGE_DIR, "vendor/bilibili_config.json"))),
			credential: {
				sessdata: env("BILIBILI_SESSDATA"),
				biliJct: env("BILIBILI_BILI_JCT"),
				buvid3: env("BILIBILI_BUVID3"),
			},
			timeoutMs: envInt("BILIBILI_TIMEOUT_MS", 20000),
		},
		tencentCloud: {
			secretId: env("TENCENTCLOUD_SECRET_ID"),
			secretKey: env("TENCENTCLOUD_SECRET_KEY"),
			securityToken: env("TENCENTCLOUD_SECURITY_TOKEN"),
			region: env("TENCENTCLOUD_REGION", "ap-guangzhou"),
			instanceId: env("TENCENTCLOUD_CVM_INSTANCE_ID"),
			instances: parseTencentCloudInstances(),
			monitorNamespace: env("TENCENTCLOUD_MONITOR_NAMESPACE", "QCE/CVM"),
			monitorDimensionName: env("TENCENTCLOUD_MONITOR_DIMENSION_NAME", "InstanceId"),
			monitorMetrics: envList(
				"TENCENTCLOUD_MONITOR_METRICS",
				"CpuUsage,CpuLoadavg,MemUsage,CvmDiskUsage,WanIntraffic,WanOuttraffic,TcpCurrEstab",
			),
			monitorPeriod: envInt("TENCENTCLOUD_MONITOR_PERIOD", 60),
			monitorWindowMinutes: envInt("TENCENTCLOUD_MONITOR_WINDOW_MINUTES", 10),
			timeoutMs: envInt("TENCENTCLOUD_TIMEOUT_MS", 10000),
		},
		xBearerToken: env("X_BEARER_TOKEN"),
		dataDir,
	};
}

function envList(name: string, fallback: string) {
	return env(name, fallback)
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseTencentCloudInstances(): TencentCloudCvmTarget[] {
	const defaultRegion = env("TENCENTCLOUD_REGION", "ap-guangzhou");
	const list = env("TENCENTCLOUD_CVM_INSTANCES");
	if (list) {
		return list
			.split(",")
			.map((item) => {
				const [region, instanceId, ...aliasParts] = item.split(":").map((part) => part.trim());
				return {
					region: region || defaultRegion,
					instanceId,
					alias: aliasParts.join(":"),
				};
			})
			.filter((item) => item.instanceId);
	}
	const singleInstanceId = env("TENCENTCLOUD_CVM_INSTANCE_ID");
	if (!singleInstanceId) return [];
	return [
		{
			region: defaultRegion,
			instanceId: singleInstanceId,
			alias: env("TENCENTCLOUD_CVM_INSTANCE_ALIAS"),
		},
	];
}

function loadDotEnv(path: string) {
	if (!existsSync(path)) return;
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match || process.env[match[1]] !== undefined) continue;
		process.env[match[1]] = unquoteEnvValue(match[2].trim());
	}
}

function unquoteEnvValue(value: string) {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}
