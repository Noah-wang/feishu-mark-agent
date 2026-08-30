# Mark Decision Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a general-purpose Feishu decision agent that searches Mark's archive first, safely supplements it from the web, produces evidence-backed recommendations, and saves decisions for later review.

**Architecture:** The existing planner gains explicit new-decision and decision-history actions. A bounded Decision Agent loop chooses among knowledge search, web search, source reading, and synthesis tools; every result is persisted locally and optionally mirrored to a separate Feishu document. External queries are model-generated from public requirements and then deterministically redacted before network use.

**Tech Stack:** TypeScript, Node.js 22 built-in `fetch`, JSON/Markdown local storage, Feishu Open API, Node test runner.

---

### Task 1: Decision domain and configuration

**Files:**
- Modify: `packages/feishu-knowledge-agent/src/types.ts`
- Modify: `packages/feishu-knowledge-agent/src/config.ts`
- Modify: `packages/feishu-knowledge-agent/.env.example`

**Steps:**
1. Add decision brief, evidence, candidate assessment, result, and saved decision types.
2. Add planner actions for creating and querying decisions.
3. Add bounded agent, web search, and Feishu decision-document configuration.
4. Run TypeScript compilation and confirm existing callers reveal all required updates.

### Task 2: Safe web research and decision persistence

**Files:**
- Create: `packages/feishu-knowledge-agent/src/webSearch.ts`
- Create: `packages/feishu-knowledge-agent/src/decisionStore.ts`
- Create: `packages/feishu-knowledge-agent/test/webSearch.test.mjs`
- Create: `packages/feishu-knowledge-agent/test/decisionStore.test.mjs`

**Steps:**
1. Write tests for secret, private URL, IP, email, Feishu id, and internal-name redaction.
2. Implement redaction and a Bing RSS/custom JSON search adapter with timeouts and result caps.
3. Write tests for saving, listing, searching, and rendering decision records.
4. Implement `decisions.json` as source of truth and `decisions.md` as its local mirror.

### Task 3: Bounded Decision Agent loop

**Files:**
- Create: `packages/feishu-knowledge-agent/src/decisionAgent.ts`
- Modify: `packages/feishu-knowledge-agent/src/analyzer.ts`
- Create: `packages/feishu-knowledge-agent/test/decisionAgent.test.mjs`

**Steps:**
1. Export the existing strict-JSON model runner for reuse.
2. Add prompts for a public decision brief, next-tool selection, final candidate comparison, and historical-decision answers.
3. Implement a maximum-step loop with knowledge search, web search, source reading, deduplication, progress callbacks, and deterministic fallback ordering.
4. Require evidence ids for material candidate claims and preserve unknowns instead of inventing facts.
5. Test one-question clarification, fallback execution, source deduplication, and historical retrieval.

### Task 4: Planner and Feishu runtime integration

**Files:**
- Modify: `packages/feishu-knowledge-agent/src/analyzer.ts`
- Modify: `packages/feishu-knowledge-agent/src/server.ts`

**Steps:**
1. Route selection/comparison/should-we questions to `make_decision` and review questions to `query_decisions`.
2. Reuse the existing clarification memory so a decision asks at most one critical question.
3. Replace the old recommendation path only for decision actions; keep archive Q&A behavior compatible.
4. Show internal-search, web-search, source-reading, comparison, and saving progress in one Feishu card.
5. Render concise recommendation, alternatives, condition matrix, risks, unknowns, sources, and the decision-center link.

### Task 5: Separate Decision Center document

**Files:**
- Create: `packages/feishu-knowledge-agent/src/decisionDoc.ts`
- Modify: `packages/feishu-knowledge-agent/src/feishu.ts`
- Create: `packages/feishu-knowledge-agent/src/create-decision-doc.ts`
- Modify: `packages/feishu-knowledge-agent/package.json`
- Create: `packages/feishu-knowledge-agent/test/decisionDoc.test.mjs`

**Steps:**
1. Build Feishu document blocks from saved decision records.
2. Generalize configured document id resolution without changing knowledge-document behavior.
3. Add full Decision Center sync and a one-time document creation command.
4. Keep local persistence successful when Feishu document sync fails, and report the missing mirror in chat.

### Task 6: Verification, docs, commit, and deployment

**Files:**
- Modify: `README.md`
- Modify: `packages/feishu-knowledge-agent/README.md`
- Modify: `packages/feishu-knowledge-agent/package.json`

**Steps:**
1. Add a package test command that builds then runs Node tests.
2. Run all new tests, TypeScript build, formatting checks, and `git diff --check`.
3. Document examples, privacy behavior, environment variables, Decision Center setup, and operational limits.
4. Commit the feature in focused commits and push only after local verification.
5. Deploy the package to the existing server, preserve its `.env` and `.knowledge` data, restart PM2, and verify `/health` plus logs.
