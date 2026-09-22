# omo V2 P1 前置 — Agent 注入机制 Spike 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 确定 OpenCode V2 中「新增一个 agent」的受支持机制，为 P1（把 omo 的 agent/模型/variant/categories 接入 V2）提供确定的技术路径。

**Architecture:** 纯调查任务，不改生产代码。在一个隔离的 scratch 项目里逐个试验三种候选机制（`ctx.agent.transform` 隐式新增 / V2 配置 `agents` / `.opencode/agents/*.md` 文件），每次用 `GET /api/agent` 取证。

**Tech Stack:** OpenCode V2 (`opencode` 2.0.11)、`@opencode/plugin` 2.0.11、Bun。

## Global Constraints

- **不修改用户全局配置**：所有试验放在 `/tmp/omo-v2-agent-probe`，用 `XDG_CONFIG_HOME` 隔离。
- 不修改 `packages/omo-opencode/src` 下的任何生产代码。
- 结论必须带**原始证据**（`GET /api/agent` 的 JSON 片段 + 命令）。
- 许可证 SUL-1.0：不得移除许可证/版权声明。
- 工作仓库：`/home/user/omo-v2`；工具链 `export PATH="$HOME/.bun/bin:$PATH"`；网络需代理 `export https_proxy=http://192.168.170.73:7898 http_proxy=http://192.168.170.73:7898`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `/tmp/omo-v2-agent-probe/`（scratch，不入库） | 隔离试验项目 |
| `docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md`（新建，提交） | 结论与证据记录 |

---

### Task 1: 确定 V2 新增 agent 的受支持机制

**Files:**
- Create: `/tmp/omo-v2-agent-probe/`（scratch）
- Create: `docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md`

**Interfaces:**
- Produces: 一份结论，明确「机制 X 可在 V2 新增 agent」并给出证据；若三条都不行，明确写出失败证据与可选替代（如让 omo 生成 agent 文件 / 依赖 opencode 配置）。

- [ ] **Step 1: 读实现，先做静态判断**

```bash
cd /home/user/omo-v2
echo "=== AgentEditor 实现 ==="
grep -rn "AgentEditor\|agents\.\|agent\." node_modules/@opencode/plugin/dist/promise/*.js 2>/dev/null | head -40
echo "=== Agent.Info schema ==="
find node_modules/@opencode -name "*.d.ts" | xargs grep -ln "namespace Agent\|Agent.Info\|interface Info" 2>/dev/null | head
```

记录 `AgentEditor.update` 对**不存在 id** 的行为（读实现推断；随后实测确认）。

- [ ] **Step 2: 搭隔离 scratch 项目**

```bash
mkdir -p /tmp/omo-v2-agent-probe/{.opencode/plugins,xdg}
cat > /tmp/omo-v2-agent-probe/opencode.json <<'JSON'
{ "$schema": "https://opencode.ai/config.json" }
JSON
cat > /tmp/omo-v2-agent-probe/.opencode/plugins/probe.ts <<'TS'
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "probe.agent-injection",
  async setup(ctx) {
    await ctx.agent.transform((editor) => {
      editor.update("probe-agent", (agent) => {
        agent.description = "probe agent created via transform"
      })
    })
  },
})
TS
```

- [ ] **Step 3: 试验 A — transform.update 能否隐式新增**

```bash
cd /tmp/omo-v2-agent-probe
export PATH="$HOME/.bun/bin:$PATH"
XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg opencode serve --hostname 127.0.0.1 --port 14300 --print-logs > /tmp/omo-v2-agent-probe/a.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:14300/api/agent | tee /tmp/omo-v2-agent-probe/a-agent.json | head -c 800; echo
pkill -f "port 14300" || true
```

判定：`probe-agent` 是否出现在 `GET /api/agent` 中。记录结论（是/否）+ JSON 片段。

- [ ] **Step 4: 试验 B — V2 配置 `agents` 字段**

```bash
cat > /tmp/omo-v2-agent-probe/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "probe-config-agent": { "description": "agent from config", "model": "litellm/deepseek-flash" }
  }
}
JSON
cd /tmp/omo-v2-agent-probe
XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg opencode serve --hostname 127.0.0.1 --port 14301 --print-logs > /tmp/omo-v2-agent-probe/b.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:14301/api/agent | tee /tmp/omo-v2-agent-probe/b-agent.json | head -c 800; echo
pkill -f "port 14301" || true
```

判定：`probe-config-agent` 是否出现。若报配置字段错误，记录确切错误文本（说明 `agents` 的真实形状）。

- [ ] **Step 5: 试验 C — `.opencode/agents/*.md` 文件**

```bash
mkdir -p /tmp/omo-v2-agent-probe/.opencode/agents
cat > /tmp/omo-v2-agent-probe/.opencode/agents/probe-file-agent.md <<'MD'
---
description: agent from markdown file
mode: primary
---
You are a probe agent.
MD
cd /tmp/omo-v2-agent-probe
XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg opencode serve --hostname 127.0.0.1 --port 14302 --print-logs > /tmp/omo-v2-agent-probe/c.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:14302/api/agent | tee /tmp/omo-v2-agent-probe/c-agent.json | head -c 800; echo
pkill -f "port 14302" || true
```

判定：`probe-file-agent` 是否出现。

- [ ] **Step 6: 汇总结论并落盘**

把三条试验的判定、证据片段、以及**推荐机制**写入：
`docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md`

必须明确回答：
1. 哪条机制能新增 agent（可多选）。
2. 该机制是否支持设置 model / variant / description / mode / tools。
3. 是否支持在插件 `setup(ctx)` 中程序化注入（这是 omo 需要的）。
4. 若都不支持程序化注入，给出替代路径（文件生成 / 配置写入）及其代价。

- [ ] **Step 7: Commit**

```bash
cd /home/user/omo-v2
git add -f docs/superpowers/notes/2026-09-22-v2-agent-injection-findings.md
git commit -m "docs(p1): V2 agent injection mechanism findings"
```

---

## Self-Review

**1. Spec/目标覆盖**：本计划只覆盖 P1 的前置未知（V2 能否新增 agent）——这正是 P1 spec 里标注的风险点；P1.1+ 依赖本结论，故先做。
**2. 占位符扫描**：无 TBD/TODO；每条试验含完整命令与判定标准。
**3. 一致性**：三条试验使用不同端口（14300/14301/14302）避免冲突；均用 `XDG_CONFIG_HOME` 隔离；产物统一写入 `/tmp/omo-v2-agent-probe/`。
