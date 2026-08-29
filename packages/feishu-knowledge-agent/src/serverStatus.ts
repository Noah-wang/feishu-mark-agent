import { execFile } from "node:child_process";
import type { BinaryLike } from "node:crypto";
import { createHash, createHmac } from "node:crypto";
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import type { Config, TencentCloudCvmTarget } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ServerStatusReport {
	generatedAt: string;
	local: {
		hostname: string;
		platform: string;
		uptimeSeconds: number;
		loadAverage: number[];
		cpuCount: number;
		memory: {
			totalBytes: number;
			freeBytes: number;
			usedPercent: number;
		};
		disk?: {
			mount: string;
			totalBytes: number;
			usedBytes: number;
			usedPercent: number;
		};
		pm2?: {
			name: string;
			status: string;
			restarts: number;
			uptime?: string;
			memoryMb?: number;
		};
		caddy?: string;
	};
	tencentCloud?: {
		configured: boolean;
		instances: TencentCloudInstanceStatus[];
		error?: string;
	};
}

interface TencentCloudMetricStatus {
	name: string;
	label: string;
	unit: string;
	value?: number;
	timestamp?: string;
	error?: string;
}

interface TencentCloudInstanceStatus {
	region: string;
	instanceId: string;
	alias: string;
	instanceName?: string;
	instanceState?: string;
	privateIps: string[];
	publicIps: string[];
	metrics: TencentCloudMetricStatus[];
	error?: string;
}

const METRIC_LABELS: Record<string, { label: string; unit: string }> = {
	CpuUsage: { label: "CPU", unit: "%" },
	CpuLoadavg: { label: "1 分钟负载", unit: "" },
	MemUsage: { label: "内存", unit: "%" },
	CvmDiskUsage: { label: "磁盘", unit: "%" },
	DiskUsage: { label: "磁盘", unit: "%" },
	WanIntraffic: { label: "公网入带宽", unit: "Mbps" },
	WanOuttraffic: { label: "公网出带宽", unit: "Mbps" },
	LanIntraffic: { label: "内网入带宽", unit: "Mbps" },
	LanOuttraffic: { label: "内网出带宽", unit: "Mbps" },
	TcpCurrEstab: { label: "TCP 连接", unit: "个" },
};

export async function collectServerStatus(config: Config, query = ""): Promise<ServerStatusReport> {
	const [disk, pm2, caddy, tencentCloud] = await Promise.all([
		collectDiskStatus().catch(() => undefined),
		collectPm2Status().catch(() => undefined),
		collectCaddyStatus().catch(() => undefined),
		collectTencentCloudStatus(config, query).catch((error) => ({
			configured: isTencentCloudConfigured(config),
			instances: [],
			error: error instanceof Error ? error.message : String(error),
		})),
	]);
	const totalMemory = safeNumber(totalmem, 0);
	const freeMemory = safeNumber(freemem, 0);
	return {
		generatedAt: new Date().toISOString(),
		local: {
			hostname: safeString(hostname, "unknown"),
			platform: `${safeString(platform, "unknown")} ${safeString(release, "")}`.trim(),
			uptimeSeconds: safeNumber(uptime, 0),
			loadAverage: safeArray(loadavg),
			cpuCount: safeArray(cpus).length,
			memory: {
				totalBytes: totalMemory,
				freeBytes: freeMemory,
				usedPercent: percent(totalMemory - freeMemory, totalMemory),
			},
			disk,
			pm2,
			caddy,
		},
		tencentCloud,
	};
}

export function renderServerStatusReport(report: ServerStatusReport): string {
	const local = report.local;
	const lines = [
		`更新时间：${formatDateTime(report.generatedAt)}`,
		`主机：${local.hostname}`,
		`运行时间：${formatDuration(local.uptimeSeconds)}`,
		`CPU 负载：${local.loadAverage.map((value) => value.toFixed(2)).join(" / ")}，核心数 ${local.cpuCount}`,
		`内存：${local.memory.usedPercent.toFixed(1)}% 已用，剩余 ${formatBytes(local.memory.freeBytes)}`,
	];
	if (local.disk) {
		lines.push(
			`磁盘：${local.disk.mount} 已用 ${local.disk.usedPercent.toFixed(1)}%，剩余 ${formatBytes(local.disk.totalBytes - local.disk.usedBytes)}`,
		);
	}
	if (local.pm2) {
		lines.push(
			`Mark 进程：${local.pm2.status}，重启 ${local.pm2.restarts} 次，内存 ${local.pm2.memoryMb?.toFixed(1) ?? "-"} MB`,
		);
	}
	if (local.caddy) {
		lines.push(`Caddy：${local.caddy}`);
	}

	const cloud = report.tencentCloud;
	if (!cloud) return lines.join("\n");
	if (!cloud.configured) {
		lines.push("", "腾讯云监控：未配置密钥或服务器清单，当前只显示 Mark 所在服务器的本机状态。");
		return lines.join("\n");
	}
	if (cloud.error) {
		lines.push("", `腾讯云监控：读取失败，${cloud.error}`);
		return lines.join("\n");
	}
	if (!cloud.instances.length) {
		lines.push("", "腾讯云监控：没有匹配到要查看的服务器。");
		return lines.join("\n");
	}
	lines.push("", `腾讯云监控：${cloud.instances.length} 台`);
	for (const instance of cloud.instances) {
		lines.push("", renderCloudInstance(instance));
	}
	return lines.join("\n");
}

async function collectDiskStatus() {
	const { stdout } = await execFileAsync("df", ["-Pk", "/"], { timeout: 5000 });
	const lines = stdout.trim().split(/\r?\n/);
	const parts = lines[1]?.trim().split(/\s+/);
	if (!parts || parts.length < 6) return undefined;
	const totalKb = Number(parts[1]);
	const usedKb = Number(parts[2]);
	const mount = parts[5] ?? "/";
	return {
		mount,
		totalBytes: totalKb * 1024,
		usedBytes: usedKb * 1024,
		usedPercent: percent(usedKb, totalKb),
	};
}

async function collectPm2Status() {
	const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 5000 });
	const processes = JSON.parse(stdout) as any[];
	const mark = processes.find((processInfo) => processInfo.name === "mark-feishu-agent") ?? processes[0];
	if (!mark) return undefined;
	return {
		name: String(mark.name ?? "-"),
		status: String(mark.pm2_env?.status ?? "-"),
		restarts: Number(mark.pm2_env?.restart_time ?? 0),
		uptime: mark.pm2_env?.pm_uptime ? new Date(Number(mark.pm2_env.pm_uptime)).toISOString() : undefined,
		memoryMb: typeof mark.monit?.memory === "number" ? mark.monit.memory / 1024 / 1024 : undefined,
	};
}

async function collectCaddyStatus() {
	const { stdout } = await execFileAsync("systemctl", ["is-active", "caddy"], { timeout: 5000 });
	return stdout.trim();
}

async function collectTencentCloudStatus(config: Config, query: string): Promise<ServerStatusReport["tencentCloud"]> {
	if (!isTencentCloudConfigured(config)) {
		return {
			configured: false,
			instances: [],
		};
	}

	const targets = filterTargets(config.tencentCloud.instances, query);
	const instances = await collectTencentCloudTargets(config, targets);
	return {
		configured: true,
		instances,
	};
}

function isTencentCloudConfigured(config: Config) {
	return Boolean(
		config.tencentCloud.secretId && config.tencentCloud.secretKey && config.tencentCloud.instances.length,
	);
}

async function collectTencentCloudTargets(config: Config, targets: TencentCloudCvmTarget[]) {
	const groups = groupTargetsByRegion(targets);
	const results: TencentCloudInstanceStatus[] = [];
	for (const [region, regionTargets] of groups) {
		const ids = regionTargets.map((target) => target.instanceId);
		const instances = await describeInstances(config, region, ids).catch(() => []);
		const instancesById = new Map(instances.map((instance: any) => [String(instance.InstanceId), instance]));
		const metricMaps = await Promise.all(
			config.tencentCloud.monitorMetrics.map((metricName) =>
				getMonitorMetricBatch(config, region, regionTargets, metricName).catch((error) => ({
					metricName,
					error: error instanceof Error ? error.message : String(error),
					values: new Map<string, TencentCloudMetricStatus>(),
				})),
			),
		);
		for (const target of regionTargets) {
			const instance = instancesById.get(target.instanceId) as any | undefined;
			results.push({
				region,
				instanceId: target.instanceId,
				alias: target.alias,
				instanceName: instance?.InstanceName,
				instanceState: instance?.InstanceState,
				privateIps: Array.isArray(instance?.PrivateIpAddresses) ? instance.PrivateIpAddresses : [],
				publicIps: Array.isArray(instance?.PublicIpAddresses) ? instance.PublicIpAddresses : [],
				metrics: metricMaps.map((metricMap) => {
					const fallback = { name: metricMap.metricName, ...metricLabel(metricMap.metricName) };
					return (
						metricMap.values.get(target.instanceId) ??
						("error" in metricMap ? { ...fallback, error: metricMap.error } : fallback)
					);
				}),
				error: instance ? undefined : "DescribeInstances 没有返回这台实例",
			});
		}
	}
	return results;
}

async function describeInstances(config: Config, region: string, instanceIds: string[]): Promise<any[]> {
	const body = await tencentCloudRequest(config, {
		service: "cvm",
		host: "cvm.tencentcloudapi.com",
		action: "DescribeInstances",
		version: "2017-03-12",
		region,
		payload: { InstanceIds: instanceIds },
	});
	return Array.isArray(body.Response?.InstanceSet) ? body.Response.InstanceSet : [];
}

async function getMonitorMetricBatch(
	config: Config,
	region: string,
	targets: TencentCloudCvmTarget[],
	metricName: string,
) {
	const end = new Date();
	const start = new Date(end.getTime() - config.tencentCloud.monitorWindowMinutes * 60 * 1000);
	const body = await tencentCloudRequest(config, {
		service: "monitor",
		host: "monitor.tencentcloudapi.com",
		action: "GetMonitorData",
		version: "2018-07-24",
		region,
		payload: {
			Namespace: config.tencentCloud.monitorNamespace,
			MetricName: metricName,
			Period: config.tencentCloud.monitorPeriod,
			StartTime: start.toISOString(),
			EndTime: end.toISOString(),
			Instances: targets.map((target) => ({
				Dimensions: [{ Name: config.tencentCloud.monitorDimensionName, Value: target.instanceId }],
			})),
		},
	});
	const response = body.Response;
	if (response?.Error) throw new Error(`${response.Error.Code}: ${response.Error.Message}`);
	const values = new Map<string, TencentCloudMetricStatus>();
	const dataPoints = Array.isArray(response?.DataPoints) ? response.DataPoints : [];
	for (const dataPoint of dataPoints) {
		const instanceId = extractInstanceIdFromDataPoint(dataPoint, config.tencentCloud.monitorDimensionName);
		if (!instanceId) continue;
		const metricValues = Array.isArray(dataPoint?.Values) ? dataPoint.Values : [];
		const timestamps = Array.isArray(dataPoint?.Timestamps) ? dataPoint.Timestamps : [];
		const lastIndex = metricValues.map((value: unknown) => typeof value === "number").lastIndexOf(true);
		values.set(instanceId, {
			name: metricName,
			...metricLabel(metricName),
			value: lastIndex >= 0 ? metricValues[lastIndex] : undefined,
			timestamp: lastIndex >= 0 ? timestamps[lastIndex] : undefined,
		});
	}
	return { metricName, values };
}

async function tencentCloudRequest(
	config: Config,
	request: {
		service: string;
		host: string;
		action: string;
		version: string;
		region: string;
		payload: Record<string, unknown>;
	},
) {
	const payload = JSON.stringify(request.payload);
	const timestamp = Math.floor(Date.now() / 1000);
	const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
	const authorization = buildAuthorization(config, request.service, request.host, payload, timestamp, date);
	const headers: Record<string, string> = {
		Authorization: authorization,
		"Content-Type": "application/json; charset=utf-8",
		Host: request.host,
		"X-TC-Action": request.action,
		"X-TC-Version": request.version,
		"X-TC-Timestamp": String(timestamp),
		"X-TC-Region": request.region,
		"X-TC-Language": "zh-CN",
	};
	if (config.tencentCloud.securityToken) headers["X-TC-Token"] = config.tencentCloud.securityToken;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.tencentCloud.timeoutMs);
	try {
		const response = await fetch(`https://${request.host}`, {
			method: "POST",
			headers,
			body: payload,
			signal: controller.signal,
		});
		const body = (await response.json()) as any;
		if (!response.ok) throw new Error(`Tencent Cloud request failed: ${JSON.stringify(body).slice(0, 500)}`);
		if (body.Response?.Error) throw new Error(`${body.Response.Error.Code}: ${body.Response.Error.Message}`);
		return body;
	} finally {
		clearTimeout(timer);
	}
}

function buildAuthorization(
	config: Config,
	service: string,
	host: string,
	payload: string,
	timestamp: number,
	date: string,
) {
	const hashedRequestPayload = sha256Hex(payload);
	const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
	const signedHeaders = "content-type;host";
	const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;
	const credentialScope = `${date}/${service}/tc3_request`;
	const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
	const secretDate = hmac(`TC3${config.tencentCloud.secretKey}`, date);
	const secretService = hmac(secretDate, service);
	const secretSigning = hmac(secretService, "tc3_request");
	const signature = hmacHex(secretSigning, stringToSign);
	return `TC3-HMAC-SHA256 Credential=${config.tencentCloud.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function metricLabel(metricName: string) {
	return METRIC_LABELS[metricName] ?? { label: metricName, unit: "" };
}

function filterTargets(targets: TencentCloudCvmTarget[], query: string) {
	const normalized = query.trim().toLowerCase();
	if (!normalized || /(全部|所有|all|整体|总览|概览)/i.test(normalized)) return targets;
	const matched = targets.filter((target) => {
		const haystack = [target.alias, target.instanceId, target.region].filter(Boolean).join(" ").toLowerCase();
		return haystack && normalized.includes(haystack);
	});
	return matched.length ? matched : targets;
}

function groupTargetsByRegion(targets: TencentCloudCvmTarget[]) {
	const groups = new Map<string, TencentCloudCvmTarget[]>();
	for (const target of targets) {
		const regionTargets = groups.get(target.region) ?? [];
		regionTargets.push(target);
		groups.set(target.region, regionTargets);
	}
	return groups;
}

function extractInstanceIdFromDataPoint(dataPoint: any, dimensionName: string) {
	const dimensions = dataPoint?.Dimensions;
	if (!Array.isArray(dimensions)) return "";
	for (const dimension of dimensions) {
		const name = String(dimension.Name ?? dimension.name ?? "");
		if (name.toLowerCase() === dimensionName.toLowerCase()) return String(dimension.Value ?? dimension.value ?? "");
	}
	return "";
}

function renderCloudInstance(instance: TencentCloudInstanceStatus) {
	const title = `${instance.alias || instance.instanceName || instance.instanceId} (${instance.region})`;
	const lines = [`${title}：${instance.instanceState || "未知状态"}`];
	if (instance.publicIps.length) lines.push(`公网 IP：${instance.publicIps.join(", ")}`);
	if (instance.privateIps.length) lines.push(`内网 IP：${instance.privateIps.join(", ")}`);
	if (instance.error) lines.push(`实例信息：${instance.error}`);
	for (const metric of instance.metrics) {
		const value =
			metric.value === undefined ? "-" : `${roundMetric(metric.value)}${metric.unit ? ` ${metric.unit}` : ""}`;
		lines.push(`- ${metric.label}：${metric.error ? `读取失败 (${metric.error})` : value}`);
	}
	return lines.join("\n");
}

function hmac(key: BinaryLike, message: string) {
	return createHmac("sha256", key).update(message).digest();
}

function hmacHex(key: BinaryLike, message: string) {
	return createHmac("sha256", key).update(message).digest("hex");
}

function sha256Hex(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function percent(used: number, total: number) {
	return total > 0 ? (used / total) * 100 : 0;
}

function roundMetric(value: number) {
	return Math.abs(value) < 10 ? value.toFixed(2) : value.toFixed(1);
}

function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number) {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
}

function formatDateTime(value: string) {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(value));
}

function safeNumber(read: () => number, fallback: number) {
	try {
		const value = read();
		return Number.isFinite(value) ? value : fallback;
	} catch {
		return fallback;
	}
}

function safeString(read: () => string, fallback: string) {
	try {
		return read() || fallback;
	} catch {
		return fallback;
	}
}

function safeArray<T>(read: () => T[]) {
	try {
		return read();
	} catch {
		return [];
	}
}
