import { decisionStatusLabel } from "./decisionStore.js";
import { BLOCK_BULLET, BLOCK_HEADING1, BLOCK_HEADING2, BLOCK_HEADING3, BLOCK_TEXT, type DocBlock } from "./doc.js";
import type { DecisionConditionStatus, DecisionRecord } from "./types.js";

const MAX_RUN_LENGTH = 1500;

export function buildDecisionBlocks(decisions: DecisionRecord[]): DocBlock[] {
	const blocks: DocBlock[] = [
		textBlock(BLOCK_HEADING1, "heading1", "Mark 决策中心"),
		textBlock(
			BLOCK_TEXT,
			"text",
			`共 ${decisions.length} 条决策 · 更新于 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
		),
	];
	if (!decisions.length) {
		blocks.push(
			textBlock(BLOCK_TEXT, "text", "还没有保存任何决策。在飞书里向 Mark 提出选择或比较问题，结果会出现在这里。"),
		);
		return blocks;
	}

	for (const decision of decisions) blocks.push(...buildOneDecision(decision));
	return blocks;
}

function buildOneDecision(decision: DecisionRecord): DocBlock[] {
	const blocks: DocBlock[] = [
		textBlock(BLOCK_HEADING2, "heading2", decision.question),
		textBlock(
			BLOCK_TEXT,
			"text",
			`${decisionStatusLabel(decision.status)} · ${decision.requester || "飞书用户"} · ${decision.createdAt.slice(0, 10)}`,
		),
		textBlock(BLOCK_TEXT, "text", `目标：${decision.goal}`),
	];
	if (decision.hardConstraints.length) {
		blocks.push(textBlock(BLOCK_TEXT, "text", `硬性条件：${decision.hardConstraints.join("；")}`));
	}
	if (decision.assumptions.length)
		blocks.push(textBlock(BLOCK_TEXT, "text", `假设：${decision.assumptions.join("；")}`));
	blocks.push(textBlock(BLOCK_HEADING3, "heading3", "建议"));
	blocks.push(textBlock(BLOCK_TEXT, "text", decision.recommendation));
	blocks.push(textBlock(BLOCK_TEXT, "text", decision.rationale));

	if (decision.candidates.length) {
		blocks.push(textBlock(BLOCK_HEADING3, "heading3", "候选方案"));
		for (const candidate of decision.candidates) {
			blocks.push(textBlock(BLOCK_TEXT, "text", `${candidate.name}${candidate.url ? ` · ${candidate.url}` : ""}`));
			if (candidate.summary) blocks.push(textBlock(BLOCK_TEXT, "text", candidate.summary));
			for (const condition of candidate.conditions) {
				blocks.push(
					textBlock(
						BLOCK_BULLET,
						"bullet",
						`${conditionStatusLabel(condition.status)} ${condition.criterion}：${condition.reason}`,
					),
				);
			}
		}
	}

	appendList(blocks, "风险", decision.risks);
	appendList(blocks, "待验证", decision.unknowns);
	appendList(blocks, "下一步", decision.nextSteps);
	if (decision.evidence.length) {
		blocks.push(textBlock(BLOCK_HEADING3, "heading3", "证据来源"));
		for (const evidence of decision.evidence) {
			blocks.push(textBlock(BLOCK_BULLET, "bullet", `[${evidence.id}] ${evidence.title} · ${evidence.url}`));
		}
	}
	return blocks;
}

function appendList(blocks: DocBlock[], title: string, values: string[]) {
	if (!values.length) return;
	blocks.push(textBlock(BLOCK_HEADING3, "heading3", title));
	for (const value of values) blocks.push(textBlock(BLOCK_BULLET, "bullet", value));
}

function textBlock(type: number, key: string, content: string): DocBlock {
	const collapsed = content.replace(/\s+/g, " ").trim();
	const text = collapsed.length > MAX_RUN_LENGTH ? `${collapsed.slice(0, MAX_RUN_LENGTH - 1)}…` : collapsed;
	return { block_type: type, [key]: { elements: [{ text_run: { content: text } }] } };
}

function conditionStatusLabel(status: DecisionConditionStatus) {
	return { met: "[满足]", partial: "[部分满足]", not_met: "[不满足]", unknown: "[未知]" }[status];
}
