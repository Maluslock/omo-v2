# omo V2 双版本 — P0 骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 oh-my-openagent(omo) 的 fork 在 OpenCode V2 里能被加载（id 出现在插件列表、`setup()` 被执行），同时 V1 仍照常工作。

**Architecture:** 在 omo 的默认导出上做「双版本」：保留 V1 的 `server()`，新增 V2 的 `Plugin.define({ id, setup })`。P0 只交付骨架——`setup()` 为空（不注册任何业务 hook），用于验证整条链路成立。业务能力在 P1 之后逐个补齐。

**Tech Stack:** TypeScript、Bun（构建 + `bun:test`）、`tsgo`（类型检查）、`@opencode/plugin@^2.0.11`（V2 API）、`@opencode-ai/plugin@1.15.13`（V1 API，保留）。

## Global Constraints

- OpenCode V2 版本：`2.0.11`；V2 插件 API 包固定 `@opencode/plugin@^2.0.11`。
- V1 插件 API 包保持 `@opencode-ai/plugin@1.15.13` 不变，**不得破坏 V1 加载**。
- 包管理器：**Bun**（仓库用 `bun.lock`/`bunfig.toml`）；测试用 `bun:test`；类型检查用 `tsgo`。
- 构建仅针对 index 入口（P0 不跑全套重管线）：
  `bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm --external zod --external @opencode/plugin`
- 许可证 **SUL-1.0**：允许个人/非商业修改与自用；**不得移除许可证与版权声明**；对外分发受非商业限制。
- 验证时**不要改全局 OpenCode 配置**，只在临时 scratch 项目里做。
- 源码工作区：`/home/user/omo-v2`（已由 `v4.19.4` tarball 解压）。
- 网络需走代理：`export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/omo-opencode/src/v2/create-v2-plugin.ts`（新建） | 产出 V2 插件定义 `{ id, setup }`（P0 为空 setup） |
| `packages/omo-opencode/src/v2/create-v2-plugin.test.ts`（新建） | 断言 V2 定义形状 |
| `packages/omo-opencode/src/index.ts`（修改） | 默认导出改为「双版本对象」 |
| `packages/omo-opencode/src/index.export-shape.test.ts`（修改） | 断言 V1 `server` 对齐 + V2 `id/setup` 存在 |
| `package.json`（根，修改） | 依赖加入 `@opencode/plugin` |
| `packages/omo-opencode/package.json`（修改） | 依赖加入 `@opencode/plugin` |

---

### Task 1: 建立 fork 工作区与 Bun 工具链

**Files:**
- Create: `/home/user/omo-v2/.git`（git 初始化）

**Interfaces:**
- Produces: 可运行的 `bun`、可构建的 `/home/user/omo-v2` 工作区、可通过的基线测试。

- [ ] **Step 1: 初始化 git 仓库并记录上游**

```bash
cd /home/user/omo-v2
git init
git add -A
git commit -m "chore: import oh-my-openagent v4.19.4 source"
git remote add upstream https://github.com/code-yeongyu/oh-my-openagent.git || true
git log --oneline -1
```

Expected: 出现一条 `chore: import ...` 提交。

- [ ] **Step 2: 安装 Bun**

```bash
export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Expected: 打印类似 `1.3.x` 的版本号。
若 `bun.sh` 不可达，回退：`npm i -g bun` 后再 `bun --version`。

- [ ] **Step 3: 安装工作区依赖**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898
bun install
```

Expected: 结束无 error（warning 可忽略）。

- [ ] **Step 4: 跑基线测试**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/index.export-shape.test.ts
```

Expected: PASS（当前 V1 导出形状测试通过）。

- [ ] **Step 5: Commit**

```bash
cd /home/user/omo-v2
git add -A
git commit -m "chore: verified baseline build/test toolchain"
```

---

### Task 2: 引入 `@opencode/plugin` 并实现 V2 骨架插件

**Files:**
- Create: `packages/omo-opencode/src/v2/create-v2-plugin.test.ts`
- Create: `packages/omo-opencode/src/v2/create-v2-plugin.ts`
- Modify: `package.json`（根，`dependencies` 增加 `@opencode/plugin`）
- Modify: `packages/omo-opencode/package.json`（`dependencies` 增加 `@opencode/plugin`）

**Interfaces:**
- Produces: `createV2Plugin(): { id: string; setup: (ctx: unknown) => Promise<void> }`
  - `id` 恒为 `"oh-my-openagent"`
  - `setup` 为函数（P0 内不注册任何 hook）

- [ ] **Step 1: 写失败测试**

```ts
// packages/omo-opencode/src/v2/create-v2-plugin.test.ts
import { describe, expect, it } from "bun:test"
import { createV2Plugin } from "./create-v2-plugin"

describe("createV2Plugin", () => {
  it("returns a V2 definition with the omo id and a setup function", () => {
    const plugin = createV2Plugin()
    expect(plugin.id).toBe("oh-my-openagent")
    expect(typeof plugin.setup).toBe("function")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/v2/create-v2-plugin.test.ts
```

Expected: FAIL（找不到模块 `./create-v2-plugin`）。

- [ ] **Step 3: 添加依赖并安装**

在根 `package.json` 的 `dependencies` 中加入：

```json
"@opencode/plugin": "^2.0.11",
```

在 `packages/omo-opencode/package.json` 的 `dependencies` 中加入同样一行，然后：

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898
bun install
```

- [ ] **Step 4: 写最小实现**

```ts
// packages/omo-opencode/src/v2/create-v2-plugin.ts
import { Plugin } from "@opencode/plugin"

export type V2PluginDefinition = ReturnType<typeof Plugin.define>

/**
 * P0 skeleton: exposes the V2 entrypoint with an empty setup().
 * Business hooks (agents, tools, session hooks, events) land in P1+.
 */
export function createV2Plugin(): V2PluginDefinition {
  return Plugin.define({
    id: "oh-my-openagent",
    async setup() {
      // P0: no hooks registered yet. Loadability is the deliverable.
    },
  })
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/v2/create-v2-plugin.test.ts
```

Expected: PASS（1 pass）。

- [ ] **Step 6: Commit**

```bash
cd /home/user/omo-v2
git add package.json packages/omo-opencode/package.json bun.lock \
        packages/omo-opencode/src/v2/create-v2-plugin.ts \
        packages/omo-opencode/src/v2/create-v2-plugin.test.ts
git commit -m "feat(v2): add empty V2 plugin skeleton definition"
```

---

### Task 3: 双版本默认导出

**Files:**
- Modify: `packages/omo-opencode/src/index.ts`
- Modify: `packages/omo-opencode/src/index.export-shape.test.ts`

**Interfaces:**
- Consumes: `createV2Plugin()`（Task 2）
- Produces: 默认导出对象 `{ id: "oh-my-openagent", setup, server }`
  - `server` 与 `omoPlugin`（具名导出）严格同一引用
  - V1 读 `server`；V2 读 `id` + `setup`（忽略 `server`）

- [ ] **Step 1: 改测试为失败态**

```ts
// packages/omo-opencode/src/index.export-shape.test.ts
import { describe, expect, it } from "bun:test"
import pluginModule, { omoPlugin } from "./index"

describe("oh-my-openagent plugin export shape", () => {
  it("keeps the V1 server export aligned with the default module", () => {
    // given
    const defaultServer = pluginModule.server

    // when
    const namedServer = omoPlugin

    // then
    expect(typeof defaultServer).toBe("function")
    expect(namedServer).toBe(defaultServer)
  })

  it("exposes a V2 definition (id + setup) on the default export", () => {
    expect(pluginModule.id).toBe("oh-my-openagent")
    expect(typeof pluginModule.setup).toBe("function")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/index.export-shape.test.ts
```

Expected: FAIL（`pluginModule.setup` 为 `undefined`）。

- [ ] **Step 3: 改入口为双版本导出**

```ts
// packages/omo-opencode/src/index.ts
import type { PluginModule } from "@opencode-ai/plugin"
import { createPluginModule } from "./testing/create-plugin-module"
import { createV2Plugin } from "./v2/create-v2-plugin"

const pluginModule: PluginModule = createPluginModule()

/** V1 entrypoint, kept for `@opencode-ai/plugin` hosts. */
export const omoPlugin = pluginModule.server

/**
 * Dual-version default export.
 * - V1 calls `server(input, options)` and uses the returned hooks.
 * - V2 reads `id` + `setup(ctx)` and ignores `server`.
 */
export default {
  ...pluginModule,
  ...createV2Plugin(),
}

export type {
  AgentName,
  AgentOverrideConfig,
  AgentOverrides,
  BuiltinCommandName,
  HookName,
  McpName,
  OhMyOpenCodeConfig,
} from "./config"

export type { ConfigLoadError } from "./shared/config-errors"
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/omo-opencode/src/index.export-shape.test.ts
```

Expected: PASS（2 pass）。

- [ ] **Step 5: 类型检查 omo-opencode**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
npx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

Expected: 无类型错误。
若 `tsgo` 未安装，回退：`npx tsc --noEmit -p packages/omo-opencode/tsconfig.json`。

- [ ] **Step 6: Commit**

```bash
cd /home/user/omo-v2
git add packages/omo-opencode/src/index.ts packages/omo-opencode/src/index.export-shape.test.ts
git commit -m "feat(v2): dual-version default export (server + setup)"
```

---

### Task 4: 构建 index bundle 并在 V2 真实加载

**Files:**
- Create: `/tmp/omo-v2-verify/.opencode/plugins/omo-local.ts`（scratch，不入库）
- Create: `/tmp/omo-v2-verify/opencode.json`（scratch，不入库）

**Interfaces:**
- Consumes: 双版本默认导出（Task 3）
- Produces: 证据——V2 日志无 "failed to load plugin"，且 `setup()` 被执行。

- [ ] **Step 1: 构建 index bundle**

```bash
cd /home/user/omo-v2
export PATH="$HOME/.bun/bin:$PATH"
bun build packages/omo-opencode/src/index.ts \
  --outdir dist --target bun --format esm \
  --external zod --external @opencode/plugin
ls -la dist/index.js
```

Expected: 生成 `dist/index.js`。

- [ ] **Step 2: 建 scratch 项目 + 本地插件桥**

```bash
mkdir -p /tmp/omo-v2-verify/.opencode/plugins
cat > /tmp/omo-v2-verify/opencode.json <<'JSON'
{ "$schema": "https://opencode.ai/config.json" }
JSON
cat > /tmp/omo-v2-verify/.opencode/plugins/omo-local.ts <<'TS'
export { default } from "/home/user/omo-v2/dist/index.js"
TS
```

- [ ] **Step 3: 在 V2 里加载并抓日志**

```bash
cd /tmp/omo-v2-verify
opencode --standalone --print-logs run "echo p0" 2>&1 | tee /tmp/omo-v2-verify/load.log | tail -40
```

Expected: 启动成功；日志**不出现** `failed to load plugin` 且不出现 `Plugin must export a default definition`。

- [ ] **Step 4: 断言结果**

```bash
grep -c "failed to load plugin" /tmp/omo-v2-verify/load.log || true
grep -c "must export a default definition" /tmp/omo-v2-verify/load.log || true
```

Expected: 两个计数都为 `0`。

- [ ] **Step 5: V1 回归（可选但建议）**

在任意目录用 V1 二进制（若仍保留）加载同一构建，确认 `server()` 仍被调用、无报错。
若 V1 已卸载，跳过并在计划末尾记录。

---

### Task 5: 收尾提交与文档更新

**Files:**
- Modify: `/home/user/sessions/docs/superpowers/specs/2026-09-21-omo-v2-dual-version-design.md`（状态更新为 P0 完成）

- [ ] **Step 1: 更新 spec 状态**

将 spec 顶部 `- 状态：已批准（待用户复核本文件）` 改为 `- 状态：P0 完成（<日期>）`，并在 §9 里程碑表为 P0 行标注 ✅。

- [ ] **Step 2: Commit**

```bash
cd /home/user/omo-v2
git add -A && git commit -m "docs: mark P0 skeleton complete" || true
```

---

## Self-Review

**1. Spec 覆盖**
- P0 骨架（双版本入口 + 空 setup + V2 可加载 + V1 不破）→ Task 2/3/4。
- 复用现有逻辑、不重写业务 → P0 不触碰任何业务文件（仅新增 `v2/` 与改入口）。
- SUL-1.0 合规、不改全局配置 → Global Constraints + Task 4 scratch 项目。

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码；命令含预期输出。

**3. 类型一致性**：
- `createV2Plugin()` 返回 `ReturnType<typeof Plugin.define>`（即 `{ id, setup }`）；入口用 `...createV2Plugin()` 展开，**不重复** `Plugin.define`。
- `omoPlugin`（具名）与默认导出的 `server` 来自同一 `pluginModule.server`，保持同一引用。
