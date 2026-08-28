import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";

const COROS_MCP_URL = "https://mcpus.coros.com/mcp";

let client: Client | undefined;
let transport: StdioClientTransport | undefined;

async function getCorosClient() {
    if (client) return client;

    client = new Client({
        name: "pi-coros-report",
        version: "0.1.0",
    });

    transport = new StdioClientTransport({
        command: "npx",
        args: ["mcp-remote", COROS_MCP_URL],
    });

    await client.connect(transport);
    return client;
}

export default function corosReportExtension(pi: ExtensionAPI) {
    pi.registerTool({
        name: "coros_list_tools",
        label: "COROS List Tools",
        description: "List available tools from the official COROS MCP server.",
        parameters: Type.Object({}),
        async execute() {
            const coros = await getCorosClient();
            const result = await coros.listTools();

            return {
                content: [{ type: "text", text: JSON.stringify(result.tools, null, 2) }],
                details: result,
            };
        },
    });

    pi.registerTool({
        name: "coros_call_tool",
        label: "COROS Call Tool",
        description: "Call a tool from the official COROS MCP server.",
        parameters: Type.Object({
            toolName: Type.String({ description: "COROS MCP tool name" }),
            argumentsJson: Type.Optional(Type.String({ description: "JSON arguments for the COROS MCP tool" })),
        }),
        async execute(_toolCallId, params) {
            const coros = await getCorosClient();
            const args = params.argumentsJson ? JSON.parse(params.argumentsJson) : {};

            const result = await coros.callTool({
                name: params.toolName,
                arguments: args,
            });

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                details: result,
            };
        },
    });

    pi.registerCommand("coros-report", {
        description: "Generate a workout report from COROS MCP data",
        handler: async (args, ctx) => {
            if (!ctx.isIdle()) {
                ctx.ui.notify("Agent is busy. Try again after the current response finishes.", "warning");
                return;
            }

            const goal = args.trim() || "分析最近一次运动，并给出下一次训练建议";

            pi.sendUserMessage(`
请使用 COROS MCP 数据生成一份中文运动报告。

目标：${goal}

步骤：
1. 先调用 coros_list_tools 查看 COROS MCP 提供了哪些工具。
2. 选择合适的 COROS 工具读取我最近一次运动数据。
3. 如果需要参数，先说明需要什么，不要猜。
4. 基于真实 COROS 数据生成报告。
5. 不要编造心率、配速、距离、爬升、路线或训练负荷。

报告结构：
1. 本次运动总结
2. 关键数据
3. 表现分析
4. 做得好的地方
5. 可以改进的地方
6. 下一次训练建议
7. 一句话鼓励
`);
        },
    });

    pi.on("session_shutdown", async () => {
        await client?.close();
        client = undefined;
        transport = undefined;
    });
}