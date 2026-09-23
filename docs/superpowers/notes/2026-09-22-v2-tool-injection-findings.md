# V2 Tool Injection — Findings (2026-09-22)

> SPIKE for P2 (omo-v2). Question: **how can a plugin register tools in OpenCode V2,
> and what `input` schema form does V2 accept?**
> Status: **both zod (StandardSchemaV1) and raw JSON Schema work**; `execute` round-trips;
> the V1→V2 context gap is limited to `abort`, `ask`, `worktree`, per-call `directory` and
> the V1 `metadata()` callback.

## 0. Environment / toolchain

- `opencode --version` → **opencode v2.0.11** (`@opencode/cli` single-file Bun binary at
  `/home/user/.local/share/opencode2/node_modules/@opencode/cli/bin/opencode.exe`).
- `@opencode/plugin@2.0.11`, `@opencode/schema@2.0.11`, **zod 4.4.3**, Bun 1.3.14.
- Scratch probe root: `/tmp/omo-v2-tool-probe` with isolated
  `XDG_CONFIG_HOME=/tmp/omo-v2-tool-probe/xdg`; user global config untouched.
- V2 `serve` requires Basic auth: `-u opencode:probepw` with `OPENCODE_SERVER_PASSWORD=probepw`.

**Operational gotcha (confirmed again):** the location-scoped services (plugins) boot **lazily on
the first API request**. Starting `opencode serve` alone does NOT run `setup(ctx)`. A warm-up
`GET /api/info` (HTTP 200) is required, then `setup()` runs and the probe writes its files.
`/api/tool` does **not** exist (HTTP 404); there is no HTTP route that lists plugin tools.

Reproduction:

```bash
mkdir -p /tmp/omo-v2-tool-probe/.opencode/plugins /tmp/omo-v2-tool-probe/xdg
ln -sfn /home/user/omo-v2/node_modules /tmp/omo-v2-tool-probe/node_modules
# write /tmp/omo-v2-tool-probe/opencode.json and .opencode/plugins/probe-tool.ts (see appendix)
cd /tmp/omo-v2-tool-probe
export PATH="$HOME/.bun/bin:$PATH"
OPENCODE_SERVER_PASSWORD=probepw XDG_CONFIG_HOME=/tmp/omo-v2-tool-probe/xdg \
  opencode serve --hostname 127.0.0.1 --port 14400 --print-logs > probe.log 2>&1 &
sleep 6
curl -s -o /dev/null -w "info=%{http_code}\n" -u opencode:probepw http://127.0.0.1:14400/api/info
sleep 6   # allow lazy location boot to finish and run plugin setup()
cat /tmp/omo-v2-tool-probe/probe-result.json
cat /tmp/omo-v2-tool-probe/probe-call.json
pkill -f "opencode serve --hostname 127.0.0.1 --port 14400"
```

Log confirms the plugin loaded:

```
timestamp=... level=INFO message="loading plugin" id=/tmp/omo-v2-tool-probe/.opencode/plugins/probe-tool.ts entrypoint=file:///tmp/omo-v2-tool-probe/.opencode/plugins/probe-tool.ts
timestamp=... message="location services booted" directory=/tmp/omo-v2-tool-probe durationMs=132
```

---

## 1. Step 1 — static reading (SDK types)

### 1.1 V2 `@opencode/schema/dist/tool.d.ts`

```ts
export interface Context {                       // <-- V2 ToolContext (Effect layer)
    readonly sessionID: Session.ID;
    readonly agent: Agent.ID;
    readonly messageID: SessionMessage.ID;
    readonly id: CallID;
    readonly progress: (update: Metadata) => Effect.Effect<void>;
}
export type ValueSchema<A = unknown> =
    | Schema.Codec<A, any>                       // effect Schema
    | StandardSchemaV1<any, A>                   // <-- zod v4 satisfies this
    | JsonSchema.JsonSchema;                     // <-- raw JSON Schema literal
export interface Result<...> {
    readonly output?: OutputValue<Output>;
    readonly content?: string | ReadonlyArray<Content>;
    readonly metadata?: Metadata;
}
export type Info<...> = {
    readonly name: string;
    readonly input: Input;
    readonly description: string;
    readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>;
    readonly output?: Output;
    readonly options?: Options;
};
export type Options = BaseOptions & ({ readonly codemode?: true; readonly pinned?: boolean }
                                    | { readonly codemode: boolean; readonly pinned?: never });
interface BaseOptions { readonly namespace?: string; readonly permission?: string }
```

`@opencode/plugin/dist/promise/tool.d.ts` (the Promise-flavored API actually used by plugins):

```ts
export interface ToolContext extends Omit<Tool.Context, "progress"> {
    readonly progress: (update: Tool.Metadata) => Promise<void>;
}
export type Info<...> = Omit<Tool.Info<...>, "execute"> & {
    readonly execute: (input, context: ToolContext) => Promise<Tool.Result<Output>>;
};
export interface ToolEditor {
    list(): readonly (Info & { readonly id: string })[];
    get(id: string): (Info & { readonly id: string }) | undefined;
    namespace(namespace: Tool.Namespace): void;
    add<...>(tool: Info<Input, Output>): void;
    update(id: string, update: (tool) => void): void;
    remove(id: string): void;
}
export interface ToolDomain {
    readonly transform: Transform<ToolEditor>;      // (cb) => Promise<Registration>
    readonly reload: () => Promise<void>;
    readonly list: () => Promise<readonly (Info & { readonly id: string })[]>;
    readonly hook: Hooks<ToolHooks>;
}
```

### 1.2 V1 `@opencode-ai/plugin@1.15.13/dist/tool.d.ts`

```ts
export type ToolContext = {
    sessionID: string;
    messageID: string;
    agent: string;
    directory: string;   // current project directory
    worktree: string;    // project worktree root
    abort: AbortSignal;
    metadata(input: { title?: string; metadata?: {...} }): void;
    ask(input: AskInput): Promise<void>;   // permission ask
};
export declare function tool<Args extends z.ZodRawShape>(input: {
    description: string;
    args: Args;
    execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
}): ...;
```

**Correction to the plan's assumption:** V2 `ToolContext` does **not** contain `signal`. It is
`{sessionID, agent, messageID, id, progress}`. This is confirmed by both `.d.ts` layers and by the
in-binary runtime construction (see §5.1).

---

## 2. Experiment A — zod object as `input` (StandardSchemaV1)

Registered:

```ts
editor.namespace({ name: "probea", description: "zod-schema probe" })
editor.add({
  name: "zod_echo",
  description: "echo via zod schema",
  input: z.object({ text: z.string().describe("text to echo") }),   // zod 4.4.3
  execute: async (input) => ({ content: `echo:${input.text}` }),
})
```

Raw `probe-result.json` excerpt:

```json
"zodError": null,
"hasZod": true,
"zodInput": {
  "type": "object",
  "ctor": "ZodObject",
  "isZod": true,
  "hasStandard": true,
  "standardVersion": 1,
  "keys": ["toJSONSchema","def","type","parse","safeParse", ...]
},
"zodHasExecute": true
```

**Verdict A: ✅ WORKS.** `z.object(...)` is accepted directly as `input`, is retained as a
`ZodObject` implementing **Standard Schema v1** (`~standard.version === 1`), appears in
`ctx.tool.list()`, and its `execute` is callable.

## 3. Experiment B — raw JSON Schema literal as `input`

Registered:

```ts
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
  execute: async (input) => ({ content: `echo:${input.text}` }),
})
```

```json
"jsonError": null,
"hasJson": true,
"jsonInput": {
  "type": "object", "ctor": "Object", "isZod": false, "hasStandard": false,
  "keys": ["type","properties","required","additionalProperties"]
},
"jsonHasExecute": true
```

**Verdict B: ✅ WORKS.**

## 4. Step 4 — direct `execute` round-trip

`ctx.tool.list()` returns `Info & { id }` **including the `execute` function** (`typeof === "function"`),
for both probe tools. Direct invocation (no model involved):

```ts
const tool = tools.find((t) => t.id.includes("json_echo"))
const result = await tool.execute({ text: "hi" }, {})
```

Raw `probe-call.json`:

```json
{
  "jsonCallResult": { "content": "echo:hi" },
  "jsonCallError": null,
  "zodCallResult": { "content": "echo:hi" },
  "zodCallError": null
}
```

**Verdict: ✅ `callResult.content === "echo:hi"` for both zod and JSON Schema inputs.** A V1-style
`execute(args) => string|{title,output,...}` can be wrapped as V2 `execute(input) => {content}` and
round-trips. The plan's fallback (local wrapper) was **not** needed — `list()` exposes the real
registered `execute`.

## 5. In-binary schema conversion (why both work)

### 5.1 Registry snapshot — code-mode split + ToolContext construction

Extracted from the v2.0.11 binary bundle (`@opencode/Tool` registry snapshot):

```js
let A = new Map(Array.from(h).filter(([,L]) => L.options?.codemode === false)),   // direct tools
    R = new Map(Array.from(h).filter(([,L]) => L.options?.codemode !== false)),   // code-mode tools
    ...
    q = P ? Id(O, ...) : void 0,                                                  // "execute" meta-tool
    N = ... Od(O);                                                                // code-mode catalog
return {
  ...{ codeModeCatalog: N },
  definitions: [
    ...Array.from(A).sort(...).map(([,L]) => hD(L)),   // direct function tools
    ...q ? [hD(q)] : [],                               // the code-mode execute tool
  ],
  execute: k(function*(L) {
    let Q = { sessionID: L.sessionID, agent: L.agent, messageID: L.messageID,
              id: q3.make(L.call.id), progress: L.progress ?? (() => U) },        // <-- V2 ToolContext
    ...
  })
}
```

This confirms at runtime: **`ToolContext = {sessionID, agent, messageID, id, progress}`** — no
`signal`/`abort`, no `directory`, no `worktree`, no `metadata`, no `ask`.

### 5.2 `ValueSchema` → JSON schema conversion

```js
Li = (e) => typeof e === "object" && e !== null && ("~standard" in e)
ld = (e) => ("jsonSchema" in e["~standard"])
Sc = (e, r) => {
  if (ld(e)) return e["~standard"].jsonSchema[r]({ target: "draft-2020-12" });
  if (e instanceof Sr) return Nl(e, { target: "draft-2020-12", io: r });          // effect Schema
  throw Error(`Schema vendor "${e["~standard"].vendor}" does not support JSON Schema conversion`)
}
wc = (e) => { /* raw JSON Schema passthrough */ }
```

zod 4.4.3 itself installs the hook:

```js
Object.assign(e["~standard"], { jsonSchema: { input: re(e,"input"), output: re(e,"output") } })
e.toJSONSchema = qr(e, {})
```

Fallback path exists (from the MCP-SDK bundled in-binary):

```
Schema. Upgrade to zod >=4.2.0, or wrap your JSON Schema with fromJsonSchema().
"...[mcp-sdk] Your zod version does not implement `~standard.jsonSchema` (added in zod 4.2.0).
 Falling back to z.toJSONSchema(). Upgrade to zod >=4.2.0 to silence this warning."
```

So V2 supports three `input` kinds: **effect `Schema.Codec`**, **StandardSchemaV1 with
`~standard.jsonSchema`** (zod ≥ 4.2.0; ours is 4.4.3), and **raw JSON Schema literal**.

## 6. Experiment C — namespace + codemode (bonus, needed for the adapter)

Registered a third tool with `options: { namespace: "omons", codemode: false }`:

```json
"nsError": null,
"nsIds": [{ "id": "omons_ns_echo", "name": "ns_echo",
            "options": { "namespace": "omons", "codemode": false } }],
"allRecent": [
  { "id": "zod_echo", "name": "zod_echo" },
  { "id": "json_echo", "name": "json_echo" },
  { "id": "omons_ns_echo", "name": "ns_echo", "options": { "namespace": "omons", "codemode": false } }
]
```

Findings:
- **Effective tool id** = `${options.namespace}_${name}` (namespace separator is `_`).
- `editor.namespace({name, description})` only **registers namespace metadata**; it does NOT
  associate a tool or prefix its id. Association is via `tool.options.namespace`.
- Default `codemode` (undefined) → the tool is exposed **only through the `execute` Code Mode
  meta-tool** (§5.1 `R` set). To expose an omo tool directly as a normal function tool, set
  `options.codemode: false` (it then lands in the `A` set).
- `ctx.tool.list()` returns **all** registered tools regardless of the codemode split, including
  V2 built-ins (`browser_*`, `patch`, `edit`, `glob`, `grep`, `opencode_*`, `question`, `read`,
  `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`).

## 7. Step 5 — V1 → V2 `ToolContext` shim analysis

| V1 `ToolContext` | V2 `ToolContext` | Shim status |
|---|---|---|
| `sessionID` | `sessionID` | ✅ direct |
| `messageID` | `messageID` | ✅ direct |
| `agent` | `agent` | ✅ direct |
| `id` (V1 had none) | `id: CallID` | new; map to omo's `callID` carrier |
| — | `progress(update)` | new; Promise-based analogue of V1 `metadata()` |
| `directory` | ❌ not on ToolContext | ⚠️ static fallback to plugin `ctx.location.directory` only; no per-call value |
| `worktree` | ❌ not on ToolContext | ⚠️ not directly available (`Location.Info` has `directory`/`project.canonical`; `WorktreeDomain` is create/remove/list only) |
| `abort: AbortSignal` | ❌ **no `signal` at all** | ❌ unshimmable at ToolContext level |
| `metadata(fn)` | ❌ no fn; use `Result.metadata` or `progress` | ⚠️ partial |
| `ask(fn)` | ❌ no fn; global `permission` domain (`list`/`get`/`reply` + `evaluate` hook) | ❌ not directly shimmable; needs redesign |

### 7.1 `glob` / `grep` (the tools named in the brief)

`packages/omo-opencode/src/tools/glob/tools.ts:26-31` and
`packages/omo-opencode/src/tools/grep/tools.ts:37-42`:

```ts
const runtimeCtx = context as Record<string, unknown>
const dir = typeof runtimeCtx.directory === "string" ? runtimeCtx.directory : ctx.directory
```

They use **only `context.directory`**, and already have a fallback to the plugin-captured
`ctx.directory` (`PluginInput.directory`). Under V2 `runtimeCtx.directory` is `undefined`, so they
naturally fall through to the pinned `ctx.directory`, which the adapter can seed from
`setup(ctx).location.directory`. **No `worktree`/`abort`/`metadata`/`ask` usage.**

### 7.2 Other omo tools that depend on missing fields

- **`abort`** (`ctx.abort` / `ctx.abort?.aborted`):
  `tools/delegate-task/background-task.ts:149`, `tools/delegate-task/unstable-agent-task.ts:55,108`,
  `tools/delegate-task/sync-session-poller.ts:108`, `tools/background-task/create-background-task.ts:91`.
  These cannot honour cancellation under V2's current `ToolContext`.
- **`ask`** (permission): `tools/skill/tools.ts:153` (`await ctx?.ask({ permission: "skill", ... })`).
  `skill/tools.ts` also reads `ctx?.agent` (available) and `ctx?.sessionID` (available).
- **`directory`**: `tools/hashline-edit/hashline-edit-executor.ts:129`
  (`runFormattersForFile(..., context.directory, ...)`), plus glob/grep above.
- **`metadata()` callback**: `tools/hashline-edit/hashline-edit-executor.ts:81,140,164`
  (`ToolContextWithMetadata` adds `metadata?`; `publishToolMetadata` calls `ctx.metadata?.(payload)`
  and keys the pending store by `ctx.callID ?? ctx.callId ?? ctx.call_id`). V2 exposes the call id as
  `id` and has no `metadata()` fn, so the shim must (a) map V2 `id` → `callID`, and (b) either return
  `metadata` in the V2 `Result` or emit `progress`.
- **`sessionID`** only: `tools/task/task-create.ts:87,93`, `tools/task/task-update.ts:137` — ✅ fine.

No usage of `context.worktree` was found anywhere under `packages/omo-opencode/src/tools`.

## 8. Conclusions

1. **`input`: use zod directly** (`z.object(v1Args)`), no conversion needed. zod 4.4.3 satisfies
   `StandardSchemaV1`; V2 special-cases the `zod` vendor and reads `~standard.jsonSchema` (target
   `draft-2020-12` or `draft-07`). Raw JSON Schema also works as a fallback. Prefer zod because it
   is the V1 shape and keeps validation at the tool boundary.
2. **`execute` shim is viable.** Wrap `async (args, ctx) => ToolResult` as
   `async (input, context) => ({ content: <string from V1 result> , metadata?, output? })`.
   `ctx.tool.list()` exposes the registered `execute`, and a direct call returns
   `{ content: "echo:hi" }`.
3. **Context gap:** map `sessionID`/`messageID`/`agent` directly and `id`→`callID`;
   `directory` falls back to the plugin-level `location.directory`; `abort`, `ask`, `worktree`, and
   the V1 `metadata()` callback have **no direct V2 `ToolContext` equivalent**. Impact is confined to
   delegate/background-task cancellation (`abort`), the skill permission ask (`ask`), hashline
   formatting paths and the metadata store (`directory`, `metadata`).
4. **P2.1 adapter shape:**
   ```ts
   // in setup(ctx):
   const cwd = ctx.location.directory
   await ctx.tool.transform((editor) => {
     editor.namespace({ name: "omo", description: "oh-my-opencode tools" })
     for (const [name, v1] of omoTools) {
       editor.add({
         name,                                   // effective id becomes `omo_${name}`
         description: v1.description,
         input: z.object(v1.args),               // zod direct; or toJSONSchema(v1.args)
         options: { namespace: "omo", codemode: false },  // direct function tools, not Code-Mode-only
         execute: async (input, context) => {
           const v1ctx = shimV1Context(context, cwd)  // directory=cwd; abort/ask unavailable
           const r = await v1.execute(input, v1ctx)
           return typeof r === "string" ? { content: r }
                                       : { content: r.output, metadata: r.metadata }
         },
       })
     }
   })
   ```
   Keep the omo `glob`/`grep` names namespaced (e.g. `omo_glob`) because V2 ships its own built-in
   `glob`/`grep`; without a namespace the registration would collide.

## 9. Raw evidence appendix

### 9.1 `probe-result.json` (key fields; full list of ids)

```json
{
  "zodError": null, "jsonError": null, "listError": null,
  "toolIds": ["browser_tabs_list", "... (44 browser_* tools) ...", "patch", "edit", "glob", "grep",
              "opencode_session_rename", "opencode_session_move", "opencode_models", "question",
              "read", "shell", "skill", "subagent", "webfetch", "websearch", "write",
              "zod_echo", "json_echo", "omons_ns_echo"],
  "hasZod": true, "hasJson": true,
  "zodInput": { "ctor": "ZodObject", "isZod": true, "hasStandard": true, "standardVersion": 1 },
  "jsonInput": { "ctor": "Object", "hasStandard": false,
                 "keys": ["type","properties","required","additionalProperties"] },
  "zodHasExecute": true, "jsonHasExecute": true,
  "zodOptions": null, "jsonOptions": null,
  "nsError": null,
  "nsIds": [{ "id": "omons_ns_echo", "name": "ns_echo",
              "options": { "namespace": "omons", "codemode": false } }]
}
```

### 9.2 `probe-call.json`

```json
{
  "jsonCallResult": { "content": "echo:hi" }, "jsonCallError": null,
  "zodCallResult":  { "content": "echo:hi" }, "zodCallError": null
}
```

### 9.3 Probe plugin

`/tmp/omo-v2-tool-probe/.opencode/plugins/probe-tool.ts` (scratch, not committed):
Experiment A (`zod_echo`, zod object), Experiment B (`json_echo`, JSON Schema literal),
Experiment C (`ns_echo`, `options.namespace`/`codemode`), then `ctx.tool.list()` and direct
`execute({text:"hi"}, {})` calls written to `probe-result.json` / `probe-call.json`.

### 9.4 Server log highlights

```
server listening on http://127.0.0.1:14400
... message="location services booted" directory=/tmp/omo-v2-tool-probe durationMs=132
... msg="loading plugin" id=/tmp/omo-v2-tool-probe/.opencode/plugins/probe-tool.ts
... http.method=GET http.url=/api/tool http.status=404
```

No `failed to load plugin` lines; no `Skipping invalid tool registration` warnings.

## P2 验证结果（2026-09-22）

隔离 V2（`/tmp/omo-v2-tool-probe`，`XDG_CONFIG_HOME` 隔离）实测：

- 工具总数 62；其中 omo 命名空间 3 个：`omo_grep`、`omo_glob`、`omo_interactive_bash`
  （`p2-tools.json`：`omoCount:3`，每项 `hasExecute:true`，`options:{namespace:"omo",codemode:false}`）
- 真实执行：`omo_glob` 以 `{pattern:"*.md"}` 调用返回 `contentLength:8824`、`error:null`（非 `skipped`），内容以 `Found 100 file(s)` 开头
- `Skipping invalid tool registration` = 0，`failed to load plugin` = 0，`level=ERROR` = 0

### 关键缺陷（已修）

首轮**零个 omo 工具注册成功**，报错：
`Invalid tool definition omo_<name>: undefined is not an object (evaluating 'seen.ref')`

根因 = **zod 实例混用**：omo 工具 `args` 由 `@opencode-ai/plugin` 自带 zod（`tool.schema`，4.1.8）构造，而适配器用 fork 根 zod（4.4.3）做 `z.object(args)` 包装。跨实例包装使 V2 的 JSON-Schema 提取崩溃。
证据：`p2-zod-identity.json` 显示 `aVersion 4.4.3 / bVersion 4.1.8`、`aProcessJSONSchema:"function"` vs `bProcessJSONSchema:"undefined"`。

**修复**（commit `c435560`）：`tool-mapping.ts` 改用产出 args 的同一实例 —— `tool.schema.object(def.args)`。

> 教训：spike 只用同实例 zod 验证，因此漏掉了这个跨实例问题；凡是要把 zod schema 交给宿主转换的地方，都必须用「构造该 schema 的同一 zod 实例」。

---

## P2 结论修正（2026-09-23，真机复核）

首次在**真实 V2 宿主**上跑通插件注入后，发现原 §9「P2 验证结果」中「3 个 omo 工具注册成功」
的结论**不成立**。

### 原结论为什么不成立

`ctx.tool.transform(cb)` 的 `cb` 是**惰性、且会被反复调用**的：`await transform(...)` 返回时
`cb` 还没执行。原探针在 `transform` 之后立刻读 `ctx.tool.list()`，读到的是**转换前的快照**，
因此把「我们的计数器说注册了 9 个」误当成「宿主接受了 9 个」。真机日志显示的真相是：

```
level=ERROR message="Skipping invalid tool registration" namespace=omo name=glob
  error="Invalid tool definition omo_glob: undefined is not an object (evaluating 'seen.ref')"
```

8 个 omo 工具**全部被宿主拒绝**，模型侧看到的是「There is no `omo_glob` tool」。

### 真正的根因（与原 §P2 的 zod 判断不同）

不是「args 与 wrapper 用了不同 zod 版本」，而是：

`createToolRegistry` 对每个工具调用 `normalizeToolArgSchemas`，它给每个 arg schema 装上
`_zod.toJSONSchema = () => tool.schema.toJSONSchema(schema)`（`@opencode-ai/plugin` 的 zod 实例）。
V1 需要这个覆盖；V2 宿主自己走转换，命中该覆盖后**把一个 zod 实例的 schema 交给另一个实例的
转换器**，在 `zod@4.4.3/v4/core/to-json-schema.js:223` 的 `flattenRef` 抛 `seen.ref`。

实测证据：用我们 import 的根 zod 转换同一个 arg 同样失败（`rootToJSONSchemaOnArg` 失败），
而 `arg["~standard"].jsonSchema.input === fresh["~standard"].jsonSchema.input` 为 **false**
（`sameConverter: false`），即两个实例；单独用 4.4.3 转换一个全新 `z.string()` 是成功的。

### 修复

`packages/omo-opencode/src/v2/tool-mapping.ts` 新增 `stripForeignJsonSchemaOverride()`，
在 V2 边界把该覆盖删掉，让每个 schema 用自己的实例转换（commit `4835f1a`）。

真机前后对比（同一宿主）：注册错误 **8 → 0**；模型成功调用 `omo_glob {"pattern":"*.md"}`。

详见 `.omo/evidence/20260923-v2-live-host/README.md`。
