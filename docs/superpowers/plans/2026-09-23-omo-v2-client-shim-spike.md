# omo V2 P2.5 前置 — V1 client shim 可行性 Spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 确定能否用 OpenCode V2 的插件域 API（`ctx.session`/`ctx.tui`/…）复刻一个 V1 SDK 形状的 `client`，以解锁当前被跳过的 11 个 client 依赖工具（并支撑 P4）。

**Architecture:** 纯调查任务。逐个方法对照 V1 `client` 用法与 V2 域 API，判定「可直接映射 / 需适配 / V2 无等价物」，并对可映射者做最小实机验证。

**Tech Stack:** TypeScript、Bun、`@opencode/plugin@2.0.11`、`@opencode-ai/sdk`（V1 形状参考）。

## Global Constraints

- 不修改用户全局配置；探针放 `/tmp/omo-v2-client-probe`（`ln -s /home/user/omo-v2/node_modules`），`XDG_CONFIG_HOME` 隔离，`OPENCODE_SERVER_PASSWORD=probepw`。
- 不修改 `packages/omo-opencode/src` 生产代码。
- 结论必须带原始证据（`ctx` 域方法是否存在/返回值形状）。
- SUL-1.0：不得移除许可证/版权声明。
- 仓库 `/home/user/omo-v2`；`export PATH="$HOME/.bun/bin:$PATH"`；网络需代理。

---

### Task 1: 判定 V1 client 各方法在 V2 的可行性

**Files:**
- Create: `/tmp/omo-v2-client-probe/.opencode/plugins/client-probe.ts`
- Create: `docs/superpowers/notes/2026-09-23-v2-client-shim-findings.md`

**Required surface（来自生产代码 grep）**：
`session.messages/get/todo/status/promptAsync/abort/summarize/create/children`、`tui.showToast`、`app`。

- [ ] **Step 1: 列出 V2 域 API 实际暴露的方法**

```bash
cd /home/user/omo-v2
node -e "const s=require('@opencode/schema/../package.json');" 2>/dev/null
grep -nE "readonly [a-zA-Z]+(\(|:)" node_modules/@opencode/plugin/dist/promise/session.d.ts 2>/dev/null | head -40
grep -nE "readonly [a-zA-Z]+(\(|:)" node_modules/@opencode/plugin/dist/promise/tui.d.ts 2>/dev/null | head -30
ls node_modules/@opencode/plugin/dist/promise/ 2>/dev/null
```
记录每个域（session/tui/app/…）实际可调用的方法名。

- [ ] **Step 2: 探针插件枚举域 API 形状**

写 `/tmp/omo-v2-client-probe/.opencode/plugins/client-probe.ts`：在 `setup(ctx)` 中把 `Object.keys(ctx)` 与各域的 `Object.keys` / 方法存在性写入 `/tmp/omo-v2-client-probe/domains.json`（只做反射，不调用破坏性方法）。

```bash
mkdir -p /tmp/omo-v2-client-probe/.opencode/plugins /tmp/omo-v2-client-probe/xdg
ln -sfn /home/user/omo-v2/node_modules /tmp/omo-v2-client-probe/node_modules
echo '{ "$schema": "https://opencode.ai/config.json" }' > /tmp/omo-v2-client-probe/opencode.json
```

- [ ] **Step 3: 逐个判定映射并做最小调用验证**

针对 Step 1/2 的结果，对下表填「V2 等价 + 证据」：

| V1 client 用法 | 出现次数 | V2 候选 | 判定 |
|---|---|---|---|
| `session.messages` | 46 | `ctx.session.context`? | ? |
| `session.get` | 22 | `ctx.session.get` | ? |
| `session.todo` | 14 | ? | ? |
| `session.status` | 8 | ? | ? |
| `session.promptAsync` | 7 | `ctx.session.prompt` | ? |
| `session.abort` | 6 | `ctx.session.interrupt` | ? |
| `session.summarize` | 27 | `ctx.session.compact`? | ? |
| `session.create` | 4 | `ctx.session.create` | ? |
| `session.children` | 2 | ? | ? |
| `tui.showToast` | 6 | `@opencode/plugin/tui`（P5） | ? |
| `app` | 1 | ? | ? |

对「可映射」的候选，**在探针中真实调用一次**（只读方法，如 `session.get`/`context`），把返回值形状写入 `/tmp/omo-v2-client-probe/calls.json` 取证。

- [ ] **Step 4: 汇总结论并提交**

写入 `docs/superpowers/notes/2026-09-23-v2-client-shim-findings.md`，明确回答：
1. 哪些方法**可直接映射**（附 V2 方法名与调用证据）。
2. 哪些**需适配**（形状转换要点）。
3. 哪些 **V2 无等价物**（列出受影响工具与降级方案，如 TUI toast 留待 P5）。
4. 结论：写一个 `createV1ClientShim(ctx)` 能解锁 14 个工具中的几个。

```bash
cd /home/user/omo-v2
git add -f docs/superpowers/notes/2026-09-23-v2-client-shim-findings.md
git commit -m "docs(p2.5): V1 client shim feasibility findings"
```

---

## Self-Review

**1. 目标覆盖**：直接回答"client shim 能解锁多少工具"，为是否值得做 shim 提供依据。
**2. 占位符扫描**：无 TBD；Step 2 探针代码给出反射方式（不写死具体键，因需实测）。
**3. 一致性**：探针目录/端口/XDG 均隔离；只调用只读方法，避免副作用。
**已知风险**：某些域在同一插件中可能未启用（如 TUI 在 headless 下），需在结论中标注观察环境。
