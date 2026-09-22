# oh-my-openagent V2 双版本 Fork — 设计文档

- 日期：2026-09-21
- 状态：P0 完成（2026-09-22；fork 工作区 `/home/user/omo-v2`，提交见该仓库 git log）
- 主题：让 oh-my-openagent(omo) 在 OpenCode V2 上可用，同时不破坏 V1

---

## 1. 背景与问题

OpenCode V2 更换了插件 API，并**不执行 V1 插件实现**：

| | V1 | V2 |
|---|---|---|
| 插件 API 包 | `@opencode-ai/plugin`（当前 1.18.31） | `@opencode/plugin`（当前 2.0.11） |
| 默认导出形态 | `{ id, server }`（`PluginModule`，`server()` 返回 hooks 表） | `Plugin.define({ id, setup(ctx) })` |
| 上下文 | `({directory, project, client})` 入参 | `ctx.location.*` / `ctx.options` + 域方法 |
| hook 注册 | 返回字符串键的 hooks 对象 | 在所属域上 `ctx.<domain>.hook(...)` 注册 |

omo 的 `@latest`(4.19.4) 与 `@beta`(5.0.0-beta.80) **都仍基于 V1 API**，因此在 V2 加载失败：

```
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function.
(Missing key at ['default']['effect'] / ['default']['setup'])
```

上游 issue `code-yeongyu/oh-my-openagent#8485`（2026-09-19）已有，**0 评论、0 PR**，作者标明
"Workaround: None. Users must stay on OpenCode V1."

## 2. 目标与非目标

### 目标
- Fork omo @ **v4.19.4**，在**不破坏 V1** 的前提下新增 V2 实现（`Plugin.define({id, setup})`）。
- 同一个包同时支持 V1(`server()`) 与 V2(`setup()`)。
- 长期对齐 omo 全功能。
- **首个交付（P0）= 骨架**：V2 能加载插件、id 出现在插件列表、零业务 hook。

### 非目标（当前阶段）
- 不追求一次交付全部功能。
- 不修改上游仓库（先做个人 fork；上游 PR 是后续选项）。
- 不重写 omo 业务逻辑。

## 3. 现状证据（已核实）

- 仓库：`code-yeongyu/oh-my-openagent`，tag `v4.19.4` 存在。
- 根 `package.json` 是 **npm/pnpm workspace monorepo，27 个子包**
  （rules-engine, delegate-core, git-bash-mcp, mcp-*-core, lsp-core, model-core,
  omo-config-core, prompts-core, comment-checker-core, hashline-core, tmux-core,
  team-core, openclaw-core, boulder-state, telemetry-core, claude-code-compat-core,
  skills-loader-core, agents-md-core, shared-skills, omo-codex, omo-senpi,
  senpi-task, pi-goal, pi-webfetch, omo-opencode ...）。
- V2 集成点（`packages/omo-opencode/src/index.ts` @ v4.19.4，473 字节）：

  ```ts
  import type { PluginModule } from "@opencode-ai/plugin"
  import { createPluginModule } from "./testing/create-plugin-module"
  const pluginModule: PluginModule = createPluginModule()
  export const omoPlugin = pluginModule.server
  export default pluginModule            // => { id, server }
  ```

- 业务逻辑集中在 `createPluginInterface(...)` 产出的 `pluginHooks`（V1 hook 名 → handler）。
- omo 使用的主要 V1 hook（括号为 dist 中出现次数）：
  `tool.execute.after`(70) / `tool.execute.before`(56) / `chat.message`(40) /
  `session.deleted`(36) / `session.idle`(30) / `config`(27) / `session.error`(20) /
  `session.created`(16) / `experimental.chat.messages.transform`(14) /
  `session.status`(13) / `session.compacted`(13) / `experimental.session.compacting`(7) /
  `command.execute.before`(7) / `auth`(6) / `tool.result`(4) / `tool.execute`(4) /
  `tool.definition`(4) / `chat.headers`(4) 等。

## 4. 架构

入口改为双版本导出：

```ts
// packages/omo-opencode/src/index.ts
import { Plugin } from "@opencode/plugin"
import type { PluginModule } from "@opencode-ai/plugin"
import { createPluginModule } from "./testing/create-plugin-module"
import { createV2Plugin } from "./v2/create-v2-plugin"

const pluginModule: PluginModule = createPluginModule()

export const omoPlugin = pluginModule.server      // 兼容旧引用
export default {
  ...Plugin.define(createV2Plugin()),             // V2 读 id + setup
  async server() { return pluginModule.server() },// V1 继续用
}
```

新增目录 `packages/omo-opencode/src/v2/`：

- `create-v2-plugin.ts` — 返回 `{ id: "oh-my-openagent", setup }`
- `hooks/*.ts` — 每个 V1 hook 一个 V2 注册器
- `adapters/*.ts` — V1 `(input, output)` ↔ V2 单个可变 `event` 的形状转换

**核心策略**：复用现有 manager/handler，不重写业务逻辑，只重做集成层。

## 5. V1 → V2 映射（来自官方迁移指南）

| V1 hook | V2 API |
|---|---|
| `event` | `ctx.event.subscribe()` |
| `dispose` | `setup` 返回的 cleanup |
| `config` | 各域 `ctx.<domain>.transform(...)` |
| `tool`（工具表） | `ctx.tool.transform(...)` |
| `auth` | `ctx.integration.transform(...)` |
| `provider` | `ctx.provider.transform` / `ctx.model.transform` |
| `chat.message` | `ctx.session.hook("prompt", ...)` |
| `chat.params` | `ctx.session.hook("context", ...)` |
| `chat.headers` | `ctx.session.hook("model.request", ...)` 或 `"http.request"` |
| `permission.ask` | `ctx.permission.hook("evaluate", ...)` |
| `tool.execute.before` | `ctx.tool.hook("execute.before", ...)` |
| `tool.execute.after` | `ctx.tool.hook("execute.after", ...)` |
| `tool.definition` | `ctx.tool.transform(...)` |
| `shell.env` | `ctx.shell.hook("create.before", ...)` |
| `command.execute.before` | command transform 或 prompt hook（按意图） |
| `experimental.chat.system.transform` | `session.hook("context")` + 改 `event.system` |
| `experimental.chat.messages.transform` | `session.hook("context")` + 改 `event.messages` |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)` |

### 无 1:1 对应的缺口（需重新设计）
- `experimental.compaction.autocontinue`
- `experimental.provider.small_model`
- `experimental.text.complete`
- `command.execute.before`（无全局 hook）

处理原则：用 V2 的 session / provider / model / event API 重实现，**不保留 V1 内部生命周期假设**。

### 语义差异（需验证）
- V2 `prompt` hook 在**durable admission 之前**执行一次，而 V1 `chat.message` 语义不同；
  若某变换需作用于每次模型请求，应分别注册 `context`/`compaction`/`generate`/`title`。

## 6. 数据流

```
OpenCode V2 启动
  -> 解析 plugins 配置 -> import 包
  -> 读默认导出 id + setup -> 运行 setup(ctx)
       |- ctx.agent.transform    (注入自定义 agent / 模型 / variant)
       |- ctx.tool.transform     (注册 omo 工具)
       |- ctx.tool.hook(...)     (execute.before/after)
       |- ctx.session.hook(...)  (prompt/context/compaction/model.request)
       |- ctx.permission.hook(...)
       |- ctx.shell.hook(...)
       |- ctx.mcp/command/reference.transform(...)
       |- ctx.event.subscribe(...)
       |- return cleanup
  -> 每轮 session：hooks 修改可变 event -> 透传给模型/工具
  -> 卸载：cleanup 中止订阅/定时器/子进程
```

## 7. 错误处理

- transform 必须**同步、廉价、幂等、无一次性副作用**；外部数据先加载再注册，变化时调用 `reload()`。
- hook 抛错 = 阻断该操作（保留 V1 语义，如禁止读 `.env`）。
- 注册对象生命周期跟随插件；仅需提前移除时才保留 `registration` 并 `dispose()`。

## 8. 构建与测试策略

- 构建：pnpm workspace（`pnpm install` + 构建 `packages/omo-opencode`）。
- 本地消费：以本地路径或 git 依赖加入 OpenCode 配置的 `plugins`。
- 验收（官方 "Verify a ported plugin"）：
  1. `opencode plugin list` 出现 id 与来源。
  2. 逐个验证每个已注册 hook / transform / tool / command / event。
  3. reload / remove 验证 cleanup。
  4. 干净项目测试 options 与持久化状态。
  5. **V1 回归**：改完后仍能在 V1 正常加载。

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 骨架** ✅ | 双版本入口 + `createV2Plugin`（id + 空 setup） | 已达成（V2）：隔离 V2 下 `GET /api/plugin` 列出 `id:"oh-my-openagent" state:"active"`，失败串 0/0（证据见 `/tmp/omo-v2-verify/`）。V1 兼容**仅做 import/静态验证**：默认导出仍带可调用的 `server`；**未做 V1 实机加载**（现存 V1 1.18.4 环境与当前 V2-schema 配置不兼容，实机回归受阻）。 |
| P1 Agent | agent / 模型 / variant / categories 注入 | V2 能选到 Sisyphus/oracle 等 agent |
| P2 工具 | 38+ 工具迁到 `ctx.tool.transform`（先核心几个） | 工具可调用 |
| P3 事件/生命周期 | `session.*` 事件、retry、compaction | 事件驱动行为生效 |
| P4 配置面 | MCP / skills / commands / provider / auth | 配置注入生效 |
| P5 TUI | `@opencode-ai/plugin/tui` → `@opencode/plugin/tui` | TUI 扩展生效 |
| P6 子包 | LSP daemon / git-bash-mcp / omo-codex 等 | 独立进程可用 |

## 10. 风险

- 27 包 monorepo，构建/测试成本高。
- hook 形状差异需逐个翻译，工作量大。
- 与上游分叉（250 分支、迭代快）；上游可能自行发布 V2 版。
- TUI 插件 API 差异。
- 许可证：仓库 `LICENSE.md` 含第三方组件条款，公开 fork 前需确认义务。

## 11. 待确认问题（Open Questions）

1. V2 `prompt` hook 能否覆盖 V1 `chat.message` 的全部用例？
2. 4 个缺口 hook 在 omo 中实际的业务关键程度？（决定 P3 先后）
3. 本地消费方式：`opencode plugin add <本地路径>` 还是 git 依赖？
4. 是否需要保留 V1 支持（决定是否维护双实现）。
5. Fork 的托管位置（GitHub fork / 本地裸仓）与许可证合规。

## 12. 参考

- 插件总览：https://opencode.ai/v2/docs/build/plugins
- 插件迁移指南：https://opencode.ai/v2/docs/build/plugins/migrate-v1
- V2 CLI 插件：https://opencode.ai/v2/docs/build/plugins/cli
- 上游 issue：https://github.com/code-yeongyu/oh-my-openagent/issues/8485
