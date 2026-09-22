# omo V2 P2 前置 — Tool 注入机制 Spike 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 确定把 omo 的 V1 工具（`tool({description, args: zod, execute(args,ctx)})`）接入 OpenCode V2（`ctx.tool.transform(editor.add({name, description, input, execute}))`）的可行机制，重点回答：**V2 能否直接接受 zod（StandardSchemaV1）作为 `input`，还是必须转 JSON Schema**；以及 V1 `ToolContext` 的缺失字段如何 shim。

**Architecture:** 纯调查任务。用一个自包含的探针插件在隔离 scratch 项目里注册 2 个代表性工具（`glob`、`grep` 的等价物），分别尝试两种 `input` 形态，并在 `setup` 内**直接调用**适配后的 `execute` 验证往返；把 `ctx.tool.list()` 与调用结果写入日志取证。

**Tech Stack:** OpenCode V2 (`opencode` 2.0.11)、`@opencode/plugin` 2.0.11、zod 4.4.3、Bun。

## Global Constraints

- 不修改用户全局配置；探针放 `/tmp/omo-v2-tool-probe`，`XDG_CONFIG_HOME` 隔离，`OPENCODE_SERVER_PASSWORD=probepw`、curl `-u opencode:probepw`。
- 不修改 `packages/omo-opencode/src` 的生产代码（spike 只调查）。
- 结论必须带原始证据（日志中的 `ctx.tool.list()` 输出与 execute 返回值）。
- SUL-1.0：不得移除许可证/版权声明。
- 仓库 `/home/user/omo-v2`；`export PATH="$HOME/.bun/bin:$PATH"`；网络需代理 `export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `/tmp/omo-v2-tool-probe/`（scratch，不入库） | 隔离探针项目 + 探针插件 |
| `docs/superpowers/notes/2026-09-22-v2-tool-injection-findings.md`（新建，提交） | 结论与证据 |

---

### Task 1: 确定 V2 工具注入机制与 input schema 形态

**Files:**
- Create: `/tmp/omo-v2-tool-probe/.opencode/plugins/probe-tool.ts`
- Create: `/tmp/omo-v2-tool-probe/opencode.json`
- Create: `docs/superpowers/notes/2026-09-22-v2-tool-injection-findings.md`

**Interfaces:**
- Produces: 结论——`input` 用 zod(StandardSchemaV1) 还是 JSON Schema；V1→V2 `execute`/context/result 的 shim 是否可行；附证据。

- [ ] **Step 1: 静态阅读**

```bash
cd /home/user/omo-v2
S=node_modules/.bun/@opencode+schema@2.0.11/node_modules/@opencode/schema/dist
sed -n '30,80p' "$S/tool.d.ts"
V1P=$(find node_modules/.bun -path "*@opencode-ai+plugin@1.15.13*" -name "tool.d.ts" | head -1)
sed -n '1,60p' "$V1P"
```
记录：V2 `ValueSchema = Schema.Codec | StandardSchemaV1 | JsonSchema.JsonSchema`；V1 `ToolContext = {sessionID,messageID,agent,directory,worktree,abort,metadata,ask}`；V2 `ToolContext = {sessionID,messageID,agent,id,progress,signal}`。

- [ ] **Step 2: 搭探针项目与探针插件**

```bash
mkdir -p /tmp/omo-v2-tool-probe/.opencode/plugins /tmp/omo-v2-tool-probe/xdg
cat > /tmp/omo-v2-tool-probe/opencode.json <<'JSON'
{ "$schema": "https://opencode.ai/config.json" }
JSON
```

探针插件（两半：A 用 zod StandardSchema，B 用 JSON Schema；并把 `list()` 与直接调用结果写文件）：

```ts
// /tmp/omo-v2-tool-probe/.opencode/plugins/probe-tool.ts
import { Plugin } from "@opencode/plugin"
import { writeFileSync } from "node:fs"
import { z } from "zod"

function report(step: string, data: unknown) {
  writeFileSync(`/tmp/omo-v2-tool-probe/${step}.json`, JSON.stringify(data, null, 2))
}

export default Plugin.define({
  id: "probe.tool-injection",
  async setup(ctx) {
    // Experiment A: zod object as input (StandardSchemaV1)
    let zodErr: string | undefined
    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "probea", description: "zod-schema probe" })
        editor.add({
          name: "zod_echo",
          description: "echo via zod schema",
          input: z.object({ text: z.string().describe("text to echo") }),
          execute: async (input: { text: string }) => ({ content: `echo:${input.text}` }),
        })
      })
    } catch (e) { zodErr = e instanceof Error ? e.message : String(e) }

    // Experiment B: JSON Schema as input
    let jsonErr: string | undefined
    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "probeb", description: "json-schema probe" })
        editor.add({
          name: "json_echo",
          description: "echo via json schema",
          input: {
            type: "object",
            properties: { text: { type: "string", description: "text to echo" } },
            required: ["text"],
            additionalProperties: false,
          },
          execute: async (input: { text: string }) => ({ content: `echo:${input.text}` }),
        })
      })
    } catch (e) { jsonErr = e instanceof Error ? e.message : String(e) }

    const tools = await ctx.tool.list()
    report("probe-result", {
      zodError: zodErr ?? null,
      jsonError: jsonErr ?? null,
      toolIds: tools.map((t) => t.id),
      hasZod: tools.some((t) => t.id.includes("zod_echo")),
      hasJson: tools.some((t) => t.id.includes("json_echo")),
    })
  },
})
```

- [ ] **Step 3: 运行探针并抓证据**

```bash
cd /tmp/omo-v2-tool-probe
export PATH="$HOME/.bun/bin:$PATH"
OPENCODE_SERVER_PASSWORD=probepw XDG_CONFIG_HOME=/tmp/omo-v2-tool-probe/xdg \
  opencode serve --hostname 127.0.0.1 --port 14400 --print-logs > /tmp/omo-v2-tool-probe/probe.log 2>&1 &
sleep 8
cat /tmp/omo-v2-tool-probe/probe-result.json 2>/dev/null || echo "(no probe-result)"
grep -c "failed to load plugin" /tmp/omo-v2-tool-probe/probe.log || true
pkill -f -- "--port 14400" || true
```

判定：
- `hasJson == true` 且 `jsonError == null` → JSON Schema 路线可行。
- `hasZod == true` 且 `zodError == null` → **zod 可直接用**（首选，省掉转换）。
- 两者都失败 → 报告 BLOCKED，附 `zodError`/`jsonError` 原文。

- [ ] **Step 4: 直接调用 execute 验证往返（不依赖模型）**

在探针插件里追加：注册后直接调用工具执行器一次并记录返回。用 `ctx.tool.list()` 取到 `Info`，若其暴露 `execute` 则调用；否则用一个更小的本地函数复现同样的适配包装并调用。记录返回对象的 `content`。

```ts
// 追加到 setup 末尾（示意）
const echo = tools.find((t) => t.id.includes("json_echo"))
let callResult: unknown = null
if (echo && typeof (echo as { execute?: unknown }).execute === "function") {
  callResult = await (echo as { execute: (i: unknown, c: unknown) => Promise<unknown> })
    .execute({ text: "hi" }, {})
}
report("probe-call", { callResult })
```

判定：`callResult.content === "echo:hi"` → execute 往返可行。

- [ ] **Step 5: 上下文 shim 可行性**

静态检查 omo 的 `glob`/`grep` 工具 execute 用到的 V1 context 字段（`grep -n "context\\.\\|runtimeCtx\\." tools/glob/tools.ts tools/grep/tools.ts`），逐个对照 V2 `ToolContext`，列出可映射（`directory→ctx.location.directory`、`abort→signal`）与不可映射（`ask`、`worktree`）的字段，并记录影响。

- [ ] **Step 6: 汇总结论并提交**

写入 `docs/superpowers/notes/2026-09-22-v2-tool-injection-findings.md`，明确回答：
1. `input` 该用 zod 还是 JSON Schema（附证据）。
2. V1 `execute` 能否包装为 V2 `execute`（结果包装 `{content}`、签名）。
3. context 哪些字段可 shim、哪些缺失、缺失对 omo 工具的影响面。
4. 推出 P2.1 适配器应采用的形态。

```bash
cd /home/user/omo-v2
git add -f docs/superpowers/notes/2026-09-22-v2-tool-injection-findings.md
git commit -m "docs(p2): V2 tool injection mechanism findings"
```

---

## Self-Review

**1. 目标覆盖**：回答了 P2 设计里标注的三个关键未知（zod vs JSON Schema、context shim、execute 往返）。
**2. 占位符扫描**：无 TBD；探针代码完整；判定条件明确。
**3. 一致性**：两实验用不同 namespace（probea/probeb）避免命名冲突；端口 14400；产物统一写 `/tmp/omo-v2-tool-probe/`。
**已知风险**：若 `ctx.tool.list()` 返回的 `Info` 不暴露 `execute`，Step 4 退化为本地包装验证，结论标注该限制。
