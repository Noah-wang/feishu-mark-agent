/** One-off bootstrap for the separate Mark Decision Center document. */
import { loadConfig } from "./config.js";
import { FeishuClient } from "./feishu.js";

const config = await loadConfig();
if (!config.feishu.appId || !config.feishu.appSecret) {
	console.error("需要先在 .env 里配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。");
	process.exit(1);
}
if (config.feishu.decisionDocId) {
	console.log(`FEISHU_DECISION_DOC_ID 已经配置：${config.feishu.decisionDocId}`);
	console.log(`https://feishu.cn/docx/${config.feishu.decisionDocId}`);
	process.exit(0);
}

const feishu = new FeishuClient(config);
const documentId = await feishu.createKnowledgeDoc("Mark 决策中心", config.feishu.decisionDocFolderToken);
console.log("决策中心已创建。把下面这行加进 .env：\n");
console.log(`FEISHU_DECISION_DOC_ID=${documentId}`);
console.log(`\n文档地址：https://feishu.cn/docx/${documentId}`);
console.log("\n请在飞书里把自己或相关群组加为协作者。");
