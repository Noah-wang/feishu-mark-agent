/**
 * One-off bootstrap: creates the Feishu doc that the knowledge base mirrors into,
 * then prints the id to put in FEISHU_DOC_ID.
 *
 * Run with: npm --workspace=@noah/feishu-knowledge-agent run doc:create
 */

import { loadConfig } from "./config.js";
import { FeishuClient } from "./feishu.js";

const config = await loadConfig();
if (!config.feishu.appId || !config.feishu.appSecret) {
	console.error("需要先在 .env 里配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。");
	process.exit(1);
}
if (config.feishu.docId) {
	console.log(`FEISHU_DOC_ID 已经配置：${config.feishu.docId}`);
	console.log(`https://feishu.cn/docx/${config.feishu.docId}`);
	console.log("如果想换一份新文档，先清空这个变量再运行。");
	process.exit(0);
}

const feishu = new FeishuClient(config);
const documentId = await feishu.createKnowledgeDoc("Mark 产品资料库", config.feishu.docFolderToken);

console.log("文档已创建。把下面这行加进 .env：\n");
console.log(`FEISHU_DOC_ID=${documentId}`);
console.log(`\n文档地址：https://feishu.cn/docx/${documentId}`);
console.log("\n注意：用 tenant_access_token 创建的文档默认只有应用自己可见。");
console.log("请在飞书里打开它，手动把你自己或群组加为协作者，否则你看不到内容。");
