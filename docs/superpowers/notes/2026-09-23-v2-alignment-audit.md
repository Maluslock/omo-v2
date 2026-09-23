# omo on OpenCode V2 — 对齐审计（2026-09-23）

> 目的：完整验证测试 + 对照 omo 官方文档，判断 V2 移植与原版功能的对齐程度。
> 方法：真实 `opencode v2.0.11` 宿主加载 omo bundle + 全量测试 + 基线 worktree 对照。

## 0. 证据与可复现方式

```bash
# 构建（官方 script/build.ts 中的同一条命令）
bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm \
  --external zod --external @opencode/plugin

# 探针项目
mkdir -p /home/user/ocaudit/.opencode/plugins
ln -sfn /home/user/omo-v2/node_modules /home/user/ocaudit/node_modules
echo '{"$schema":"https://opencode.ai/config.json"}' > /home/user/ocaudit/opencode.json
echo 'export { default } from "/home/user/omo-v2/dist/index.js"' \
  > /home/user/ocaudit/.opencode/plugins/omo-local.ts
cd /home/user/ocaudit && opencode run --model deepseek/deepseek-v4-pro "reply ok"
```

- 全量与基线日志：`.omo/evidence/20260923-v2-alignment/`（`full-test.log`、`full-test-2.log`、`live-audit.json`）
- 基线对照：`git worktree add /home/user/omo-baseline 7cbcaca`（V2 改动之前的导入提交）

## 1. 测试结论：12794 pass / 3 skip / 15 fail，无一条由 V2 移植引入

首轮 16 条失败中，**唯一属于我们的是 `production prompt injection routes`**：审计发现
`v2/client-shim.ts` 直接调用 `session.prompt/.promptAsync`。已修复（`bb6dd00`）——把该文件加入
`RAW_PROMPT_ALLOWLIST`，理由与既有两个客户端外观先例一致：它**实现**被 gate 调用的客户端接口，
自身不做派发决策，所有 omo 调用方都经 `dispatchInternalPrompt` 到达它。重跑后 16 → 15。

其余 15 条的归属（基线 = `7cbcaca`，同样命令单跑）：

| 失败项 | 数量 | 基线 | 判定 |
|---|---|---|---|
| `auto-slash-command` 会话 ID 替换 | 4 | **同样失败** | 既有 |
| `createPluginInterface - command.execute.before` | 1 | **同样失败** | 既有 |
| `dist bundle Bun globals`（Node 下导入） | 2 | **同样失败**（`__require is not a function`） | 既有 |
| `DMCA provenance gate`（submodule HEAD） | 1 | **同样失败** | 既有（未拉 submodule） |
| Codex installer / 版本戳 | 2 | **同样失败** | 既有（需 codex 构建产物） |
| `auto-update-checker/checker > getLatestVersion` | 5 | 单跑 **5/5 通过** | 全量单进程的 mock 干扰（flaky） |

## 2. 真机功能盘点（`live-audit.json`）

```
agentCount: 16（含 OpenCode 内置 build/general/plan/explore/compaction/title/summary）
omo agent:  Sisyphus - ultraworker / Prometheus - Plan Builder / Atlas - Plan Executor /
            Metis - Plan Consultant / Momus - Plan Critic / librarian /
            multimodal-looker / oracle / Sisyphus-Junior   （9 个，另有 explore）
omo tools:  omo_grep omo_glob omo_interactive_bash
            omo_background_output omo_background_cancel omo_call_omo_agent
            omo_look_at omo_task omo_skill_mcp               （9 个）
总工具数:   68
```

启动日志（`/tmp/oh-my-opencode.log`）：

```
[v2] agents registered {"agentCount":12,"defaultAgent":"Sisyphus - ultraworker"}
[v2] tools registered {"registered":9,"skipped":5,"skippedTools":["session_list","session_read","session_search","session_info","skill"]}
[v2] hooks registered {"registered":9}
```

## 3. 与官方文档（`docs/reference/features.md`）的对齐矩阵

### Agents：官方 11 个 → V2 可见 10 个

| 官方 agent | V2 状态 |
|---|---|
| sisyphus / oracle / librarian / explore / multimodal-looker / prometheus / metis / momus / atlas / sisyphus-junior | ✅ 已注册（`editor.update` 会为缺失 id 建默认项） |
| hephaestus | ⚠️ 未出现——`maybeCreateHephaestusConfig` 为**条件注册**，本环境未启用（配置结果，非 V2 缺陷） |

Agent 模型链、tool 限制、categories 注入沿用 V1（P1 只做形状映射），因此与官方"每 agent 不同模型组合"一致。

### Tools：官方 20–39 → **默认配置 9，开齐配置开关 15**（见 §7 修正）

| 工具组 | 官方 | V2 | 说明 |
|---|---|---|---|
| grep / glob / edit(hashline) | 3 | 2（grep/glob） | `edit` 需 `hashline_edit` 配置，未在默认注册表 |
| LSP ×8 | 8 | 0 | 由 tier-1 `lsp` MCP 提供 → **MCP 未移植（P4）** |
| call_omo_agent / task / background_output / background_cancel | 4 | 4 | ✅（shim 解锁，子会话无 parentID 属降级） |
| look_at | 1 | 1 | ✅ |
| skill / skill_mcp | 2 | 1（skill_mcp） | `skill` 被 V2 ToolContext `ask` 缺口挡住 |
| session_list/read/search/info | 4 | 0 | 需 `session.list`/`todo`，V2 未暴露 |
| task_create/get/list/update | 4 | 0 | `experimental.task_system` + todo 同步 |
| monitor ×4 | 4 | 0 | monitor manager 依赖缺失的 client 面 |
| team ×12 | 12 | 0 | team-mode 未移植 |
| goal ×3 | 3 | 0 | `goal.enabled` 默认关 |

### Hooks：官方 54 槽（team 61）→ V2 8 个注册

V2 的 8 个注册**扇出到 V1 的 hook 组合**，因此覆盖面远大于 8：

| V2 注册 | 覆盖的官方 hook 槽 |
|---|---|
| `event.subscribe` | 27 个 event 类 hook（runtime-fallback、model-fallback、preemptive-compaction、goal、session-notification、compaction-* 等） |
| `tool.hook("execute.before")` | 18 个 ToolGuard（write-existing-file-guard、comment-checker、rules-injector、prometheus-md-only 等） |
| `tool.hook("execute.after")` | 21 个 ToolGuard（tool-output-truncator、hashline-read-enhancer、read-image-resizer 等） |
| `session.hook("prompt")` | 11 个 chat.message hook（keyword-detector、think-mode、runtime-fallback、auto-slash-command 等） |
| `session.hook("context")` ×2 | messages-transform 6 槽 + system-transform |
| `session.hook("context")`（params） | chat.params（effort / thinking / 生成参数） |
| `session.hook("compaction")` | compaction-context-injector / compaction-todo-preserver / claude-code-hooks |

未接：`chat.headers`（V2 缺 message id/role，接了只会静默 no-op）、`tool.definition`、
`command.execute.before`（V2 只有注册期 `command.transform`）、`experimental.compaction.autocontinue`、
`permission.hook("evaluate")` 与 `shell.hook("create.before")`（omo 从未有过这两个 V1 hook）。

### 其余官方能力

| 能力 | V2 状态 |
|---|---|
| Commands（`/init-deep`、`/goal`、`/refactor`、`/start-work`、`/stop-continuation`、`/handoff`） | ❌ 未移植（依赖 `command.execute.before` 缺口） |
| Skill sets（8 个内置） | ⚠️ 加载路径在，但 `skill` 工具未注册 → 模型无法主动加载 |
| 三层 MCP（内置 3 远端 + lsp + codegraph / .mcp.json / skill-embedded） | ❌ 未移植（P4） |
| Team Mode | ❌ 未移植 |
| Categories / 委派路由 | ✅（P1 agent 注入 + `task` 工具，但 `task` 为降级可用） |
| Background agents | ⚠️ 工具已注册，后台 manager 已建；端到端未验证 |
| Hashline edit + read 配对 | ⚠️ `edit` 未注册；`hashline-read-enhancer` 经 `execute.after` 生效 |
| 配置面（omo.jsonc 多级合并、迁移） | ⚠️ `loadPluginConfig` 已复用，MCP/skills/commands 段未消费 |

## 4. 总体判断

- **能用的核心闭环已通**：插件注入 → agent 选择 → 工具注册与调用 → 事件/工具/请求 hook → 模型回答。
- **对齐度粗估**：Agents ~90%（10/11，缺者为配置条件）；Tools ~9/20–39（默认配置下约 23%–45%）；
  Hooks 覆盖面约 70–80%（8 个注册扇出到 V1 组合，缺的是命令/工具定义/权限/续跑几类）。
- **最大缺口排序**：① MCP（含 LSP 8 工具）② Commands/skill 工具 ③ session_* 工具
  ④ team-mode ⑤ 后台/委派端到端验证。

## 5. 本轮修掉的真问题

1. `fix(v2): stop the V1 JSON-Schema override from breaking V2 tool registration`（`4835f1a`）——
   所有 omo 工具此前被宿主静默丢弃；真机验证注册错误 8 → 0，模型可调用 `omo_glob`。
2. `fix(v2): allowlist the V2 client shim in the prompt-async route audit`（`bb6dd00`）——
   本仓库不变量审计；首轮唯一由移植引入的失败。
3. `docs(p2): correct the tool-registration conclusion with live-host evidence`（`6ef2a67`）——
   修正 P2 findings 里基于过早读取得出的"3 个工具注册成功"。

## 6. 仍未验证 / 环境限制

- 工具**完整往返**（调用 → 结果 → 模型回答）未走通：provider 路由报
  `OpenAI Chat user messages only support text and media content for now`，**内置 `glob` 同样复现**，
  无工具的 prompt 正常 → 网关对 V2 tool-result 消息格式的限制，与插件无关。
- 事件订阅与各 V1 guard hook 的**逐项效果**尚未断言（只确认注册成功与 `context` hook 触发）。
- 本轮使用真实 service/配置（隔离实例因固定服务端口 49374 被占用而无法启动），会话写入真实
  `~/.local/share/opencode/opencode.db`；未修改用户任何配置文件。


---

## 7. 重要修正与「可攻破点」（2026-09-23 追加）

初版矩阵低估了对齐度。三点修正 + 四个已从官方文档/源码确认的可攻破点：

### 7.1 修正：很多"缺失工具"只是配置开关没开

omo 的 opencode 专属配置必须放在 **`"[opencode]"`（带方括号的键）** 这个 harness block 里，不是顶层、
也不是 `opencode`。实测（同一真机、只改配置）：

| 配置 | V1 registry | V2 注册的 omo 工具 |
|---|---|---|
| 默认 | 14 | **9** |
| `"[opencode]": { hashline_edit, goal.enabled, experimental.task_system }` | 22 | **15** |

新出现的 6 个：`omo_edit`(hashline)、`omo_create_goal` / `omo_update_goal` / `omo_get_goal`、
`omo_task_get` / `omo_task_list`。所以默认矩阵里的"缺 edit / goal / task_get"**不是移植缺陷**。

（顺带：`hephaestus` 缺失的真因是 `[agent-registration] Agent skipped: unsupported Hephaestus model`——
它的配置模型 `new-api/kimi-k2.7-code` 不被识别，属配置问题。）

### 7.2 可攻破点 A：`ctx.mcp.transform` → 恢复 5 个内置 MCP（含 8 个 LSP 工具）—— **已实现并真机验证**

```ts
interface MCPEditor { list(); get(name); set(name, config); update(name, update); remove(name) }
```
V2 插件**可以注册 MCP server**。omo 的 tier-1 内置 MCP（`lsp` 提供全部 8 个 `lsp_*` 工具、
`codegraph`，以及 3 个远端 MCP）因此是可移植的，不是只能等上游。**这是目前性价比最高的一块。**

**实现**：`src/v2/mcp-mapping.ts`（V1 配置 → V2 tag union）+ `src/v2/register-mcps.ts`
（`ctx.mcp.transform` set/update，按 `omoRuntimeKeyFor` 记忆化），已接入
`create-v2-plugin.ts` 的 setup。

**真机验证**（opencode 2.0.11，本地 dist，见
`.omo/evidence/20260923-v2-alignment/live-mcp-audit3.md`）：

| 探针目录 | omo 注册 | 宿主实际连接 |
|---|---|---|
| `/home/user/ocaudit7`（默认） | 5 个，含 `lsp` | `lsp tools=8`、`websearch tools=1`、`context7 tools=2`、`grep_app tools=1`、`codegraph tools=0` |
| `/home/user/ocaudit8`（`disabled_mcps:["lsp"]`） | 4 个，无 `lsp` | **无 `lsp`**；其余照旧 |

宿主日志里的 `mcp connected server=lsp tools=8` 是宿主 MCP client 完成 stdio 握手后自己打的，
omo 的 transform 单独打不出来；负对照又排除了"opencode 自带 lsp MCP"这一解释。所以
**8 个 LSP 工具在 V2 下确实回来了，且 omo 的配置开关在移植后依然生效**。

**注意（方法学修正）**：`ctx.tool.list()` / `ctx.mcp.list()` 在 setup 期返回空
（transform 是惰性的，MCP 是 setup 之后异步连接的），因此**不能**用"工具总数 68→74"当注册契约——
那个数字取决于采样瞬间有几个 server 连完。注册的真凭据是宿主的 `mcp connected` 行。
另外宿主拒绝以 `console.log` 输出的插件日志，探针必须写文件。

### 7.3 可攻破点 B：`ctx.command.transform.add` → 恢复 slash 命令 —— **已实现并真机验证**

```ts
interface CommandDefinition { name; description?; execute(input: {sessionID, prompt, delivery}) }
```
命令的定义带**每调用回调**，因此 `/goal`、`/refactor`、`/start-work`、`/stop-continuation`、
`/handoff`、`/remove-ai-slops`、`/hyperplan`（实际是 7 个，初版矩阵写了 6 个且误把 `init-deep`
算进来，它其实是 skill）可以在 V2 重实现。V1 的 `command.execute.before` 是全局拦截，语义不完全
等价，但 omo 这些命令都是"模板展开 + 注入"，可以 1:1 落成命令定义。

**实现**：`src/v2/command-mapping.ts`（`$ARGUMENTS`/`$SESSION_ID`/`$TIMESTAMP` 展开 + V1→V2 定义映射）、
`src/v2/command-delivery.ts`（`switchAgent` + `ctx.session.prompt`），由
`src/v2/register-commands.ts` 接入 `ctx.command.transform`。

**真机验证**（独立 XDG 的 `opencode serve` + 本地 dist，走真实会话命令 API
`POST /api/session/{id}/command`，每条命令一个全新会话；见
`.omo/evidence/20260923-v2-alignment/live-command-audit.md`，22 断言全过）：

| 断言 | 结果 |
|---|---|
| 注册数（禁用 2 个） | `registered:5` |
| 5 条启用命令 | 全部 HTTP 204 且投递出展开后的模板（`/start-work` 7497 字符、`/refactor` 18831 字符） |
| `disabled_commands` 与未知命令 | 一律 404 |
| `/start-work` 选中的 agent | `Atlas - Plan Executor`，且文本含展开后的 session id 与用户参数 |
| `command execution failed` | 0 |

**过程中挖出三个真缺陷（均已修）**：

1. **命令全部 500**：`client-shim` 有意不给 `tui`，而 `chat-message` 的
   `notifyWhenModelCacheIsMissing(client.tui)` 会 `tui.showToast(...)` —— 读 `undefined.showToast`
   是**同步抛错**，绕过调用方的 `.catch()` 并中断整条 hook 链。shim 现在提供（记录日志的）
   `tui.showToast` no-op。这条缺陷在 V1 时代不存在，属 V2 移植引入。
2. **`disabled_commands` 里写 `handoff` 会让整个数组被丢弃**：`BuiltinCommandNameSchema` 与
   `features/builtin-commands/types.ts` 漂移，少了 `handoff`，而 Zod 遇到一个不认识的值会把整个
   数组换成空默认值——用户配了 `["goal","handoff"]` 结果**什么都没禁用**。已补枚举 + 加漂移测试
   （`config/schema/commands.test.ts`）+ 重新生成两个 schema 资产。**这是 V1 就有的缺陷。**
3. **`/start-work` 静默不投递**：命令按 config key 声明 `agent: "atlas"`，但 V2 注册 omo agent 用的是
   显示名 id（`Atlas - Plan Executor`）；`switchAgent("atlas")` 会被接受，随后 session runner 抛
   `Session.AgentNotFoundError` 丢掉 prompt，而 API 仍回 204。投递前改用现成的
   `resolveRegisteredAgentName` 解析，并在未注册时记 warning。

### 7.4 可攻破点 C：`ctx.skill.transform` → 注册 skill（含 8 个内置 skill set）

```ts
interface SkillEditor { list(); get(id); add(skill); update(id, u); remove(id) }
```
`SkillDomain` 还有 `list`。omo 的 builtin skills / skill sets 可以注册进 V2。

### 7.5 可攻破点 D：`session_*` 工具其实可以无 client 运行

`tools/session-manager/storage.ts` 的逻辑是 `isSqliteBackend() && sdkClient ? SDK : 文件回退`，
而 `tools.ts:71` 只是 `setStorageClient(ctx.client)`。V2 下 `ctx.client` 即我们注入的 shim；
**若不注入（或让 sdkClient 为 null），四个 `session_*` 工具会走 `getFileMainSessions` 等文件回退路径**
——也就是说"需要 session.list"这个拉黑理由并不成立于它们全体。

**实测结论（已做）**：直接调用 `getMainSessions({directory})` / `getAllSessions()` 且不注入 client，
**能跑、不抛错，但返回 0 条**——文件回退读的是 omo 旧的文件布局，而 V2 的会话在 sqlite 里。
所以这四个工具属于"能注册、无数据"：解锁它们只有形式意义，除非能拿到 V2 的会话列表。
**结论：D 不是有效攻破点，session_* 仍是真缺口。**

同理可再评估：
- `task_create` / `task_update`：`todo-sync` 依赖 `session.todo`，shim 已提供空 stub；是否只降级而不崩，待测。
- `skill` 工具：唯一卡点是 `ctx.ask`（V2 ToolContext 无 ask）。V2 有 `permission.hook("evaluate")` +
  `ctx.permission.list/get/reply`，可以把"询问用户"改成"策略判定"或走 permission 域，从而解锁。

### 7.6 修正后的缺口排序

1. ~~**MCP（含 8 个 LSP 工具）**~~ —— **已完成并真机验证**（§7.2）；
2. ~~**Commands（7 个 slash 命令）**~~ —— **已完成并真机验证**（§7.3）；`ctx.skill.transform` 的
   skill 注册仍未做；
3. ~~`session_*` 四个~~ —— 实测**无数据**（见 §7.5），仍是真缺口；
4. **`skill` 工具** —— 用 permission 域替代 ask；
5. **team-mode / monitor** —— 工具本身在拉黑名单，需确认真实依赖。

即：**官方 20–39 的区间里，绝大多数是有路径的**，真正无解的目前只有"V2 不暴露的 host 能力"这一类。

## 8. 关键发现：已发布的 npm 包在 2.0.11 上完全加载失败

这一条不属于移植工作本身，但比移植缺口严重得多，必须记下来。

用户真实全局配置 `~/.config/opencode/opencode.json`：

```json
{ "plugin": ["superpowers@git+https://github.com/obra/superpowers.git", "oh-my-openagent@latest"] }
```

该 npm 包在当前宿主的日志里**加载失败了 502 次**：

```
level=WARN message="failed to load plugin" target=oh-my-openagent@latest
cause="PluginModule.LoadError: Plugin must export a default definition with an id and an effect or
setup function. (cause: SchemaError(Missing key at ["default"]["effect"] /
Missing key at ["default"]["setup"]))"
```

原因是已发布 bundle 导出的是 V1 形状 `{ id: "oh-my-openagent", server: ... }`，而 V2 不再接受
`server`，只认 `setup` / `effect`。也就是说：**在这台机器上，用户的 omo（npm 版）目前是彻底死的，
唯一能注册东西的是本地 V2 shim。** 这正是"V1 client shim → P3–P6"这条路线存在的理由，同时也是
一个待办：shim 完成后要确认发布产物能被 2.0.11 直接加载。

证据：`.omo/evidence/20260923-v2-alignment/v1-published-plugin-rejected.log`。
