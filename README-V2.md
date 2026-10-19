# omo 的 OpenCode 2.x 移植版

这是 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（简称 omo）的移植仓：
让同一份插件代码能在 **OpenCode 2.x** 上加载并工作，同时不破坏 1.x。

上游是功能、文档与行为标准的唯一真源。本仓只做一件事——把 omo 接到 2.x 的插件契约上，
顺带修几个上游在 1.x 上同样存在的 bug。**不是新的发行版，不发布 npm，不代表上游项目。**

---

## 仓库里的两条线

| 分支 | 是什么 | 用途 |
|---|---|---|
| `master` | 最早的 V2 适配工作线：2026-09 从 v4.19.4 快照导入的独立历史，含 2.0.11 → 2.0.30 的全部适配与现场证据 | 保留完整适配过程与证据，阅读参考用 |
| `feat/v2-plugin-runtime` | 重新基于上游 `dev`（`58363dcd57`）做的干净移植：9 个提交，`91 files / +11856 / −100` | 用来跑、用来验证，将来提 PR 用这个 |

`master` 与上游**没有共同祖先**，所以它不能直接当 PR 分支；真正能进上游的是 `feat/v2-plugin-runtime`。

---

## 为什么需要移植

OpenCode 2.x 把插件契约从 `{ id, server }` 换成了 `Plugin.define({ id, setup })`。
已发布的 omo 只导出 V1 形态，2.x 会直接拒绝加载：

```
WARN failed to load plugin target=oh-my-openagent@latest
     PluginModule.LoadError: Plugin must export a default definition with an id and an effect or
     setup function. (cause: Missing key at ["default"]["setup"])
```

本仓的默认导出同时给出两种形态，所以同一个包里 1.x 和 2.x 都能加载：

```ts
// packages/omo-opencode/src/index.ts
export default {
  ...pluginModule,        // { id, server }  -> OpenCode 1.x
  ...createV2Plugin(),    // { id, setup }   -> OpenCode 2.x
}
```

边界之后的一切（agents、完整 V1 hook 组合、工具工厂、MCP、skills、`team-core`、`model-core`）
都是上游代码，没有分叉。

---

## 在 2.x 上实际跑出来的结果

真实宿主 `opencode` **2.0.30** + 真实配置（不是 mock 供应商）：

```
agents   12   (default: Sisyphus - ultraworker)
tools    13 registered / 1 skipped (skill, 宿主自带)
hooks    13
mcps     4    (websearch, context7, grep_app, lsp)
commands 16
skills   21   (10 builtin, 18 from disk)
```

会话索引就绪，工具真的被调用（`omo_glob`），日志里 `ERROR_LINES=0`。

V1 回归用 1.18.31 宿主（本分支 pin 的 `@opencode-ai/plugin` 就是 1.18.31）：插件入口命中，
注册 14 个原生工具，向模型宣称 35 个工具，其中 11 个属于 omo，回合正常产出最终文本。

| 能力 | 2.x 上的做法 | 状态 |
|---|---|---|
| agents / tools / hooks / MCP / commands / skills | 对应的 `ctx.<domain>.transform` | 已移植 |
| `chat.message`、`chat.params`、`chat.headers` | `session.hook("prompt" / "context" / "model.request")` | 已移植 |
| 消息与 system 变换 | `session.hook("context").messages` / `.system` | 已移植 |
| 压缩（compaction） | `session.hook("compaction")` + 状态恢复 | 已移植 |
| 生命周期事件 | `ctx.event.subscribe`，并把 V1 事件词汇重新映射到 2.x | 已移植 |
| 会话列表 / 搜索 / 信息 | 插件自建索引（`ctx.storage`）+ 只读回填宿主 SQLite | 已移植 |
| task / monitor / team / goal 工具 | 复用 V1 实现，跑在重建的 V1 client 表面之上 | 已移植 |
| TUI 侧栏 | 2.x CLI 插件：`cli.json` 的 `plugins` 条目 + `sidebar.content` 槽位 | 已移植 |

完整矩阵、逐项证据与实测到的宿主行为见 [docs/reference/v2-port-summary.md](docs/reference/v2-port-summary.md)；
要改适配层先读 [docs/reference/v2-plugin-adapter.md](docs/reference/v2-plugin-adapter.md)。

---

## 本地装来试

```bash
git clone https://github.com/Maluslock/omo-v2.git
cd omo-v2
git switch feat/v2-plugin-runtime
OMO_SKIP_MATERIALIZE=1 bun run build
```

然后把插件目录指向构建产物：

```ts
// <项目>/.opencode/plugins/omo-local.ts   或   ~/.config/opencode/plugins/omo-local.ts
export { default } from "<本仓绝对路径>/dist/index.js"
```

跑一句看看：

```bash
opencode run --standalone "列出当前目录的 json 文件，回一行 OK"
grep -E "\[v2\] (agents|tools|hooks|mcps|commands|skills) registered" /tmp/oh-my-opencode.log | tail -6
```

几个会省时间的点：

- `OMO_SKIP_MATERIALIZE=1` 在这个检出里是必须的：裸构建会去 `git submodule update` 那些
  在 `.gitmodules` 里声明、但索引里没有 gitlink 的 `packages/shared-skills/upstreams/*`。
- 把本地路径写进 `opencode.json` 的 `plugins` 数组在 2.x 上不生效，放进插件**目录**才生效。
- 构建会顺手重写 `packages/omo-codex/scripts/install-dist/install-local.mjs`，没动 Codex 侧就还原它。

---

## 测试状态

- `bun test packages/omo-opencode/src/v2/` → **315 pass / 0 fail**（805 assertions，31 文件）
- `bun test packages/omo-opencode/` → 9184 pass / 33 fail / 1 skip；在同一台机器上用干净的
  `upstream/dev` 跑同一命令是 8875 pass / 32 fail / 1 skip，**两边失败用例名集合完全一致**
  （多出的唯一一条是临时目录泄漏守卫，属环境产物）⇒ 本分支零新增失败
- `npx tsgo --noEmit`（包级）与根 `bun run typecheck` 均为 exit 0

---

## 与上游的差异

除 V2 适配层外，本仓还带了四个上游 1.x 上同样存在的 bug 修复：

| 修复 | 上游表现 |
|---|---|
| `disabled_commands: ["handoff"]` 不再整段失效（一个未知枚举让 Zod 丢掉整个数组） | 这个键静默无效 |
| 读取 category 的 `max_tokens`（原先只读已废弃的 `maxTokens`） | 文档写的键被忽略 |
| 任务写入等待文件锁（`acquireLockAsync`） | 并发 `task_create` 报 `task_lock_unavailable` |
| 组合 `task-reminder` hook（有测试但没进任何一层） | 提醒从不触发 |

---

## 2.x 上踩到的坑（给后来人）

- **终端客户端配置换了位置。** 2.x 用全局 `~/.config/opencode/cli.json` 取代分层的 `tui.json(c)`，
  CLI 插件写在它的 `plugins` 数组里；未知设置会被拒绝。
- **会话枚举。** 2.x 不给服务端插件列会话的接口，所以 omo 自建索引，并只读地读宿主自己的
  SQLite（`opencode.db`，表 `session_v2`）来覆盖插件加载前就存在的会话。
- **权限失败关。** 2.x 的 `ToolContext` 没有 `ask`，需要授权的代码只能按自己的白名单
  （`monitor.allowed_commands`）判断，其余一律显式报错。
- **TUI 侧栏要有 client 配置条目。** `dist/tui.js` 同时导出两代形态，2.x 从 `cli.json` 读入口；
  侧栏只出现在会话视图里，不在首页。

---

## 发布与许可

- **没有 npm 包。** 分享方式只有两种：发一个带 `dist/` 的 GitHub Release，或推分支让人本地构建。
- **上游 PR 状态**：尚未提交。计划中的做法是从 `upstream/dev` 切分支、只带本移植的提交，
  走上游的 CLA 与 CI 流程。
- **许可：SUL-1.0**（`LICENSE.md`），与上游一致：允许内部商业使用与非商业/个人使用，非商业
  分发须免费，必须保留许可与版权声明，不授予上游商标。**不要把它冒充成上游项目。**

---

## 致谢

架构、功能、文档全部来自上游 [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)。
本仓目标对齐的 2.x 插件 API 见 [opencode.ai/v2/docs](https://opencode.ai/v2/docs/)（Build → plugins / CLI plugins）。
