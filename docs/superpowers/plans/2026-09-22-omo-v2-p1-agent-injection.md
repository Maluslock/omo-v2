# omo V2 P1 — Agent 注入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 OpenCode V2 中注册 omo 的完整 agent 集合（内置 + 用户/项目来源），带正确的 `model` / `variant` / `mode` / `description` / 权限。

**Architecture:** 复用 omo 既有的 agent 组装链（`loadPluginConfig` → `loadPluginComponents` → `applyAgentConfig`）产出 V1 形状的 agent map；用一个纯函数适配器把它翻译成 V2 `Agent.Info` 形状；在 `setup(ctx)` 中先 `await` 算好，再用**同步** `ctx.agent.transform` 写入（spike 已验证 `editor.update(id, fn)` 对不存在 id 会隐式创建）。

**Tech Stack:** TypeScript、Bun/`bun:test`、`tsgo`、`@opencode/plugin@2.0.11`（`Agent.Info` / `Model.Ref.parse`）。

## Global Constraints

- V2 API 仅用 `@opencode/plugin@^2.0.11`；V1 `@opencode-ai/plugin@1.15.13` 不变。
- **transform 回调必须同步**：异步数据先算好再注册；输入变化时 `ctx.agent.reload()`。
- `Agent.Info` 字段固定为 `id,name,model,request,system,description,mode,hidden,color,steps,permissions`；**没有 `tools`**，map 到 `permissions`。
- `mode` 取值只能是 `"subagent" | "primary" | "all"`。
- 模型字符串用 V2 的 `Model.Ref.parse("provider/model#variant")` 解析。
- 不修改用户全局配置；验证放 `/tmp/omo-v2-agent-probe`（已存在）。
- 许可证 SUL-1.0：不得移除许可证/版权声明。
- 工作仓库 `/home/user/omo-v2`；`export PATH="$HOME/.bun/bin:$PATH"`；网络需代理 `export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/omo-opencode/src/v2/agent-mapping.ts`（新建） | 纯函数：V1 agent config → V2 `Agent.Info` 形状 |
| `packages/omo-opencode/src/v2/agent-mapping.test.ts`（新建） | 适配器单测 |
| `packages/omo-opencode/src/v2/register-agents.ts`（新建） | 组装 omo agents 并注册到 `ctx.agent.transform` |
| `packages/omo-opencode/src/v2/create-v2-plugin.ts`（修改） | 在 `setup(ctx)` 中调用注册 |
| `docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md`（已存在） | spike 结论（背景） |

---

### Task 1: `toV2AgentInfo` 适配器（TDD）

**Files:**
- Create: `packages/omo-opencode/src/v2/agent-mapping.ts`
- Test: `packages/omo-opencode/src/v2/agent-mapping.test.ts`

**Interfaces:**
- Produces: `toV2AgentInfo(id: string, v1: Record<string, unknown>): Record<string, unknown>`
  - 返回可直接 `Object.assign` 到 `Agent.Info` 的对象
  - 处理 `description`、`mode`、`model`、`prompt→system`、`tools→permissions`、`color`、`steps`、`hidden`、`temperature/top_p→request.body`

- [ ] **Step 1: 写失败测试**

```ts
// packages/omo-opencode/src/v2/agent-mapping.test.ts
import { describe, expect, it } from "bun:test"
import { toV2AgentInfo } from "./agent-mapping"

describe("toV2AgentInfo", () => {
  it("maps description/prompt/mode and parses the model ref", () => {
    const out = toV2AgentInfo("oracle", {
      description: "consulting agent",
      mode: "subagent",
      model: "litellm/deepseek-flash#max",
      prompt: "You are Oracle.",
    })
    expect(out.name).toBe("oracle")
    expect(out.description).toBe("consulting agent")
    expect(out.mode).toBe("subagent")
    expect(out.system).toBe("You are Oracle.")
    expect(out.model).toEqual({ providerID: "litellm", id: "deepseek-flash", variant: "max" })
  })

  it("maps V1 tools to permissions (write/edit/patch collapse to edit)", () => {
    const out = toV2AgentInfo("x", { tools: { read: true, bash: false, edit: false } })
    expect(out.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })

  it("defaults mode to subagent and omits absent fields", () => {
    const out = toV2AgentInfo("y", {})
    expect(out.mode).toBe("subagent")
    expect(out.model).toBeUndefined()
    expect(out.system).toBeUndefined()
    expect(out.permissions).toBeUndefined()
  })

  it("keeps a primary mode and forwards temperature/top_p into request.body", () => {
    const out = toV2AgentInfo("z", { mode: "primary", temperature: 0.2, top_p: 0.9 })
    expect(out.mode).toBe("primary")
    expect(out.request).toEqual({ body: { temperature: 0.2, top_p: 0.9 } })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/v2/agent-mapping.test.ts
```
Expected: FAIL（`Cannot find module './agent-mapping'`）。

- [ ] **Step 3: 写实现**

```ts
// packages/omo-opencode/src/v2/agent-mapping.ts
import { Model } from "@opencode/plugin"

type V1Tools = Record<string, boolean>

const TOOL_ACTION: Record<string, string> = {
  bash: "shell",
  write: "edit",
  edit: "edit",
  patch: "edit",
}

function normalizeMode(value: unknown): "subagent" | "primary" | "all" {
  return value === "primary" || value === "all" ? value : "subagent"
}

function toPermissions(tools: unknown): Array<{ action: string; resource: string; effect: "allow" | "deny" }> | undefined {
  if (typeof tools !== "object" || tools === null) return undefined
  const entries = Object.entries(tools as V1Tools)
  if (entries.length === 0) return undefined
  return entries.map(([name, enabled]) => ({
    action: TOOL_ACTION[name] ?? name,
    resource: "*",
    effect: enabled ? "allow" : "deny",
  }))
}

export function toV2AgentInfo(id: string, v1: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: id, mode: normalizeMode(v1.mode) }

  if (typeof v1.description === "string") out.description = v1.description
  if (typeof v1.prompt === "string") out.system = v1.prompt
  if (v1.hidden === true) out.hidden = true
  if (typeof v1.color === "string") out.color = v1.color
  if (typeof v1.steps === "number") out.steps = v1.steps

  if (typeof v1.model === "string") {
    const parsed = Model.Ref.parse(v1.model)
    out.model = parsed.variant === undefined
      ? { providerID: parsed.providerID, id: parsed.id }
      : { providerID: parsed.providerID, id: parsed.id, variant: parsed.variant }
  } else if (typeof v1.model === "object" && v1.model !== null) {
    out.model = v1.model
  }

  const permissions = toPermissions(v1.tools)
  if (permissions !== undefined) out.permissions = permissions

  const body: Record<string, unknown> = {}
  if (typeof v1.temperature === "number") body.temperature = v1.temperature
  if (typeof v1.top_p === "number") body.top_p = v1.top_p
  if (Object.keys(body).length > 0) out.request = { body }

  return out
}
```

- [ ] **Step 4: 运行确认通过**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/v2/agent-mapping.test.ts
```
Expected: 4 pass / 0 fail。

- [ ] **Step 5: Commit**

```bash
cd /home/user/omo-v2
git add packages/omo-opencode/src/v2/agent-mapping.ts packages/omo-opencode/src/v2/agent-mapping.test.ts
git commit -m "feat(v2): add V1->V2 agent info mapping"
```

---

### Task 2: 组装 omo agents 并注册到 setup(ctx)

**Files:**
- Create: `packages/omo-opencode/src/v2/register-agents.ts`
- Modify: `packages/omo-opencode/src/v2/create-v2-plugin.ts`

**Interfaces:**
- Consumes: `toV2AgentInfo`（Task 1）
- Produces: `registerOmoAgents(ctx, pluginConfig, pluginComponents): Promise<void>`
  - 内部先 `await applyAgentConfig(...)`，再 `await ctx.agent.transform(...)`（同步回调）

- [ ] **Step 1: 探明 `applyAgentConfig` 的最小可用输入（先写一个临时脚本跑通）**

检查其对 `ctx.client` 与 `pluginComponents` 的真实依赖：

```bash
cd /home/user/omo-v2
grep -n "ctx.client\|params.ctx.client" packages/omo-opencode/src/plugin-handlers/agent-skill-discovery.ts packages/omo-opencode/src/plugin-handlers/agent-source-loader.ts 2>/dev/null | head
grep -n "loadPluginComponents" packages/omo-opencode/src/plugin-handlers/plugin-components-loader.ts | head
```
记录：`applyAgentConfig` 是否需要 `ctx.client`。若需要，改用 V2 `ctx` 能提供的等价物或将其置为 `undefined` 并观察是否降级可用。

- [ ] **Step 2: 写实现**

```ts
// packages/omo-opencode/src/v2/register-agents.ts
import type { Plugin } from "@opencode/plugin"
import { applyAgentConfig } from "../plugin-handlers/agent-config-handler"
import { loadPluginComponents } from "../plugin-handlers/plugin-components-loader"
import { log } from "../shared"
import { toV2AgentInfo } from "./agent-mapping"

type V2Ctx = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]

export async function registerOmoAgents(
  ctx: V2Ctx,
  pluginConfig: Record<string, unknown>,
): Promise<void> {
  const pluginComponents = await loadPluginComponents({
    pluginConfig: pluginConfig as never,
  })

  const config: Record<string, unknown> = {}
  const agentResult = await applyAgentConfig({
    config,
    pluginConfig: pluginConfig as never,
    ctx: { directory: ctx.location.directory },
    pluginComponents,
  })

  const defaultAgent =
    typeof config.default_agent === "string" ? config.default_agent : undefined

  const entries = Object.entries(agentResult)

  await ctx.agent.transform((editor) => {
    for (const [id, v1] of entries) {
      if (typeof v1 !== "object" || v1 === null) continue
      const mapped = toV2AgentInfo(id, v1 as Record<string, unknown>)
      editor.update(id, (agent) => Object.assign(agent, mapped))
    }
    if (defaultAgent !== undefined) editor.default(defaultAgent)
  })

  log("[v2] agents registered", { agentCount: entries.length, defaultAgent })
}
```

- [ ] **Step 3: 接入 `create-v2-plugin.ts`**

```ts
// packages/omo-opencode/src/v2/create-v2-plugin.ts
import { Plugin } from "@opencode/plugin"
import { loadPluginConfig } from "../plugin-config"
import { registerOmoAgents } from "./register-agents"

export type V2PluginDefinition = ReturnType<typeof Plugin.define>

export function createV2Plugin(): V2PluginDefinition {
  return Plugin.define({
    id: "oh-my-openagent",
    async setup(ctx) {
      const pluginConfig = loadPluginConfig(ctx.location.directory)
      if (pluginConfig === undefined) return
      await registerOmoAgents(ctx, pluginConfig as unknown as Record<string, unknown>)
    },
  })
}
```

> 注：`loadPluginConfig` 的真实签名/返回需在实现时按仓库实际调整；若它是同步返回配置对象，直接用；若抛错则按 `setup` 的失败策略记录并跳过。

- [ ] **Step 4: 类型检查 + 现有测试**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
npx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
bun test packages/omo-opencode/src/index.export-shape.test.ts packages/omo-opencode/src/v2/
```
Expected: tsgo exit 0；测试全通过。

- [ ] **Step 5: Commit**

```bash
cd /home/user/omo-v2
git add packages/omo-opencode/src/v2/register-agents.ts packages/omo-opencode/src/v2/create-v2-plugin.ts
git commit -m "feat(v2): register omo agents via ctx.agent.transform"
```

---

### Task 3: V2 实机验证 + V1 回归

**Files:**
- 无生产代码改动（验证任务）

**Interfaces:**
- Consumes: Task 2 的注册
- Produces: 证据——V2 `GET /api/agent` 出现 omo agents

- [ ] **Step 1: 构建 index bundle**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm \
  --external zod --external @opencode/plugin
```

- [ ] **Step 2: 在隔离 scratch 项目加载并抓 agent 列表**

```bash
cd /tmp/omo-v2-agent-probe
export PATH="$HOME/.bun/bin:$PATH"
cat > opencode.json <<'JSON'
{ "$schema": "https://opencode.ai/config.json" }
JSON
cat > .opencode/plugins/omo-local.ts <<'TS'
export { default } from "/home/user/omo-v2/dist/index.js"
TS
OPENCODE_SERVER_PASSWORD=probepw XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg \
  opencode serve --hostname 127.0.0.1 --port 14310 --print-logs > /tmp/omo-v2-agent-probe/p1.log 2>&1 &
sleep 8
curl -s -u opencode:probepw http://127.0.0.1:14310/api/agent \
  > /tmp/omo-v2-agent-probe/p1-agent.json
python3 -c "
import json
d=json.load(open('/tmp/omo-v2-agent-probe/p1-agent.json'))
ids=[a['id'] for a in d.get('data',[])]
print('agents:',len(ids))
print('omo:',[i for i in ids if i in {'sisyphus','sisyphus-junior','oracle','librarian','explore','metis','momus','multimodal-looker','atlas','hephaestus','prometheus'}])
"
pkill -f -- "--port 14310" || true
```
Expected: `omo:` 列表非空（至少 `oracle`/`librarian`/`explore` 等出现）。

- [ ] **Step 3: 抽查一个 agent 的 model/variant**

```bash
curl -s -u opencode:probepw http://127.0.0.1:14310/api/agent/oracle > /dev/null 2>&1 || true
python3 -c "
import json
d=json.load(open('/tmp/omo-v2-agent-probe/p1-agent.json'))
for a in d.get('data',[]):
    if a['id']=='oracle':
        print(json.dumps(a,indent=2)[:600])
"
```
（若 server 已停，直接从 `p1-agent.json` 读。）Expected: `oracle` 的 `model` 含配置的 `providerID/id/variant`。

- [ ] **Step 4: 失败串计数**

```bash
grep -c "failed to load plugin" /tmp/omo-v2-agent-probe/p1.log || true
grep -c "must export a default definition" /tmp/omo-v2-agent-probe/p1.log || true
```
Expected: 两个都为 0。

- [ ] **Step 5: V1 回归 + 收尾**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/index.export-shape.test.ts packages/omo-opencode/src/v2/
npx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```
Expected: 通过 + exit 0。

- [ ] **Step 6: 提交证据摘要到 notes**

把 `p1-agent.json` 的 omo agent 列表与 `oracle` 片段追加进
`docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md`（小节「P1 验证结果」），然后：

```bash
cd /home/user/omo-v2
git add -f docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md
git commit -m "docs(p1): record V2 agent registration verification"
```

---

## Self-Review

**1. 目标覆盖**：P1 Goal（agent/模型/variant/mode/描述注入）→ Task 1（适配）+ Task 2（注册）+ Task 3（验证）。categories 通过 `applyAgentConfig` 内部消费 `pluginConfig.categories` 一并生效（Task 2 复用其产物）。
**2. 占位符扫描**：无 TBD；每个代码步骤含完整代码；命令含预期输出。Task 2 Step 3 的 `loadPluginConfig` 签名标注为"实现时按实际调整"，这是已知的真实不确定点（spike 未覆盖），已显式写明而非隐藏。
**3. 类型一致性**：`toV2AgentInfo(id, v1)` 返回 `Record<string, unknown>`，Task 2 用 `Object.assign(agent, mapped)` 写入 `DeepMutable<Agent.Info>`；`Model.Ref.parse` 来自 `@opencode/plugin` 的 `Model` 再导出（已在 `dist/promise/index.d.ts` 确认）。

**已知残余风险（Task 2 需实测）**：① `applyAgentConfig` 对 `ctx.client` 的依赖；② `permissions: deny` 是否真拦截；③ 注入 agent 在 `ctx.agent.reload()` 后是否存活（若否，P1 需重注册策略）。

---

## Fix round 1 — 裁决修正（Task 1 映射）

评审证实计划本身有误，修正如下（权威来源：`applyAgentConfig` 的产物经 `migrateAgentConfig` 后**用 `permission` 而非 `tools`**；`variant` 是独立字段）：

```ts
const TOOL_ACTION: Record<string, string> = {
  bash: "shell",
  write: "edit",
  edit: "edit",
  patch: "edit",
  apply_patch: "edit",
}

// authoritative: V1 permission map Record<string, "allow"|"deny"|"ask">
// fallback:     legacy boolean tools map
function toPermissions(permission: unknown, tools: unknown) {
  if (typeof permission === "object" && permission !== null) {
    const entries = Object.entries(permission as Record<string, string>)
    if (entries.length > 0) {
      return entries.map(([name, effect]) => ({
        action: TOOL_ACTION[name] ?? name,
        resource: "*",
        effect,
      }))
    }
  }
  if (typeof tools === "object" && tools !== null) {
    const entries = Object.entries(tools as Record<string, boolean>)
    if (entries.length > 0) {
      return entries.map(([name, enabled]) => ({
        action: TOOL_ACTION[name] ?? name,
        resource: "*",
        effect: enabled ? "allow" : "deny",
      }))
    }
  }
  return undefined
}

// model：model 字符串里的 #variant 与独立 v1.variant 都要考虑
if (typeof v1.model === "string") {
  const parsed = Model.Ref.parse(v1.model)
  const variant = parsed.variant ?? (typeof v1.variant === "string" ? v1.variant : undefined)
  out.model = variant === undefined
    ? { providerID: parsed.providerID, id: parsed.id }
    : { providerID: parsed.providerID, id: parsed.id, variant }
}
```

新增测试：`permission` 含 `ask`、独立 `variant`、`apply_patch→edit`。
