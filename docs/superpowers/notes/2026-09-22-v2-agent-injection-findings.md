# V2 Agent Injection — Findings (2026-09-22)

> SPIKE for P1 (omo-v2). Question: **how can a plugin add a brand-new agent in OpenCode V2?**
> Status: **all three candidate mechanisms work**; the recommended one for `omo` is the
> programmatic `ctx.agent.transform(editor => editor.update(id, fn))`.

## 0. Environment / toolchain

- `opencode --version` → **opencode v2.0.11** (`@opencode/cli`, ELF single-file Bun binary at
  `/home/user/.local/share/opencode2/node_modules/@opencode/cli/bin/opencode.exe`).
- Installed SDK types: `@opencode/plugin@2.0.11`, `@opencode/schema@2.0.11`, in
  `/home/user/omo-v2/node_modules/@opencode/`.
- Bun `1.3.14`. Scratch root: `/tmp/omo-v2-agent-probe` (isolated `XDG_CONFIG_HOME`, **user global config untouched**).
- **Auth correction (mandatory)**: V2 `serve` requires Basic auth. Every request below used
  `-u opencode:probepw` with `OPENCODE_SERVER_PASSWORD=probepw`. Unauthenticated `GET /api/agent`
  returned **HTTP 401**; authenticated returned **HTTP 200**. Credentials: username `opencode`,
  password from `OPENCODE_SERVER_PASSWORD` (defaults auto-generated when unset).

Common launch used for every experiment:

```bash
cd /tmp/omo-v2-agent-probe
OPENCODE_SERVER_PASSWORD=probepw XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg \
  opencode serve --hostname 127.0.0.1 --port <PORT> --print-logs > <tag>.log 2>&1 &
# readiness: GET /api/info with -u opencode:probepw until 200 (max 30s)
# read:      GET /api/agent with -u opencode:probepw
# kill:      pkill -f -- "--port <PORT>"
```

**Operational gotcha (observed):** the *first* `/api/agent` request can return
`{"location":{...},"data":[]}` because location-scoped services (built-in agents + plugins) boot
lazily on that request and the response is produced before they finish. A warm-up request followed by
a short wait is required:

```bash
curl -s -u opencode:probepw "http://127.0.0.1:$PORT/api/agent" >/dev/null   # warm up / trigger boot
sleep 4
curl -s -u opencode:probepw "http://127.0.0.1:$PORT/api/agent"              # now full list
```

---

## 1. Step 1 — static reading (implementation + schema)

### 1.1 `AgentEditor` interface (SDK type)

`node_modules/@opencode/plugin/dist/promise/agent.d.ts`:

```ts
export interface AgentEditor {
    list(): readonly DeepMutable<Agent.Info>[];
    get(id: string): DeepMutable<Agent.Info> | undefined;
    default(id: string | undefined): void;
    update(id: string, update: (agent: DeepMutable<Agent.Info>) => void): void;
    remove(id: string): void;
}
export interface AgentDomain extends AgentApi {
    readonly transform: Transform<AgentEditor>;
    readonly reload: () => Promise<void>;
}
// registration.d.ts
export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;
```

### 1.2 `Agent.Info` schema

`node_modules/@opencode/schema/dist/agent.js`:

```js
export const Info = Schema.Struct({
    id: ID, name: Name,
    model: Model.Ref.pipe(optional),          // { id, providerID, variant? }
    request: Provider.Request,                // { settings, headers, body }
    system: Schema.String.pipe(optional),
    description: Schema.String.pipe(optional),
    mode: Schema.Literals(["subagent", "primary", "all"]),
    hidden: Schema.Boolean,
    color: Color.pipe(optional),
    steps: PositiveInt.pipe(optional),
    permissions: Permission.Ruleset,          // [{ action, resource, effect }]
});
// default(id) => { id, name:id, request:{settings:{},headers:{},body:{}},
//                  mode:"primary", hidden:false, permissions:[...5 default rules] }
```

**There is no `tools` field on `Agent.Info`.** Tool enablement is expressed through `permissions`
(a ruleset). The legacy file schema maps a V1 `tools:` map onto `permission` at parse time (see 1.4).

### 1.3 In-binary `AgentEditor` implementation — `update` on a **non-existent id CREATES it**

Extracted from the v2.0.11 binary bundle (`@opencode/Agent` service):

```js
f = Ta({ name:"agent", initial:()=>({agents:new Map}), editor:(i)=>({
  list:()=>dr(i.agents.values()),
  get:(a)=>i.agents.get(a),
  default:(a)=>{ i.default=a },
  update:(a,c)=>{
     let d = nl.default(a),                                  // nl === Agent.Info
         s = i.agents.get(a) ?? { ...d, permissions:[...d.permissions, ...A] };
     if (!i.agents.has(a)) i.agents.set(a, s);               // <-- implicit create
     c(s);                                                   // <-- mutate new mutable Info
     s.id = a;
  },
  remove:(a)=>{ i.agents.delete(a) }
}), notify:()=>H.publish(B8.Updated /* agent.updated */, {}).pipe(kt) })
```

**Answer to Step 1:** `update(id, fn)` on a non-existent `id` **adds a brand-new agent**. It builds
`Agent.Info.default(id)`, appends the server's default external-directory permissions, inserts it into
the registry, then runs `fn` on that mutable object. If the id exists, `fn` mutates the existing entry.
`remove(id)` deletes. This is exactly the pattern the built-in `opencode.config.agent` plugin uses.

The plugin-facing wrapper (`PluginHost`) just brands the id and forwards:

```js
agent: { get, list, reload: f.reload,
  transform:(w)=> f.transform((aH)=> w({
     list:()=>CL(aH.list()), get:(dH)=>CL(aH.get(Is.make(dH))),
     default:(dH)=>aH.default(dH===void 0?void 0:Is.make(dH)),
     update:(dH,xH)=>aH.update(Is.make(dH), xH),
     remove:(dH)=>aH.remove(Is.make(dH)) })) }
```

The transform registry (`Ta`) re-runs `initial()` + every registered transform on `get()`/`invalidate()`,
so registered transforms are re-applied after `reload` and stay registered until `dispose()`.

### 1.4 Config + markdown-file pipeline (mechanism B and C share this path)

Built-in plugin `opencode.config.agent` reads documents from these globs
(`{agent,agents}/**/*.md` and `{mode,modes}/*.md`), plus the location's `opencode.json`, then applies
them through the editor:

```js
yield*e.agent.transform((A)=>{
  ... 
  for (let T of c.documents) for (let [P,q] of Object.entries(T.info.agents ?? {})) {
    let R = Is.make(P);
    if (q.disabled) { A.remove(R); continue }
    let E = A.get(R) !== void 0;                 // exists?
    A.update(R, (Q) => {                          // update = create-or-mutate
      if (!E) Q.permissions.push(...F);
      if (q.model  !== void 0) Q.model = { id:q.model.model, providerID:q.model.providerID,
                                           ...(q.model.variant===void 0?{}:{variant:q.model.variant}) };
      if (q.request!==void 0) Object.assign(Q.request.headers, q.request.headers??{}),
                              Object.assign(Q.request.body,    q.request.body??{});
      if (q.system !== void 0) Q.system = q.system;
      if (q.description !== void 0) Q.description = q.description;
      if (q.mode !== void 0) Q.mode = q.mode;
      if (q.hidden !== void 0) Q.hidden = q.hidden;
      if (q.color !== void 0) Q.color = q.color;
      if (q.steps !== void 0) Q.steps = q.steps;
      if (q.permissions !== void 0) Q.permissions.push(...R5(q.permissions, s.home));
    });
  }
})
```

- The V2 config field is **`agents`** — `Config.Info.agents = Record<string, ConfigAgent.Info>`
  (`@opencode/schema/dist/config.js`, `config/agent.js`). `ConfigAgent.Info` fields:
  `model` (string `"provider/model"` or `{providerID, model, variant}`), `request`, `system`,
  `description`, `mode`, `hidden`, `color`, `steps`, `disabled`, `permissions`.
- Markdown file parse (`z$(...)`) derives the agent name from the path after `agent|agents|mode|modes/`
  minus `.md`, body → `system`, and wraps it as `{ agents: { [name]: frontmatter } }`.
  `agent/` and `agents/` do **not** force a mode; `mode/` and `modes/` force `mode:"primary"`.
  Frontmatter is parsed with the legacy `AgentConfig` schema when it contains keys outside the modern
  set (e.g. `tools`, `variant`), else with the modern `ConfigAgent.Info` schema. The legacy schema's
  `tools: { bash:false, read:true }` is converted to permissions (`Mx`: bool→allow/deny, and
  `write|edit|patch`→`edit`).

### 1.5 HTTP surface — no create/update endpoint

Route inventory (from bundle): `server.agent` exposes only `agent.list` (`GET /api/agent`) and
`agent.get` (`GET /api/agent/:agentID`). There is **no** agent create/update/delete HTTP route; the only
write paths are plugin `transform` and config/markdown documents.

---

## 2. Experiment A — plugin `ctx.agent.transform(editor => editor.update("new-id", ...))`

**Exact command / files** (`/tmp/omo-v2-agent-probe/.opencode/plugins/probe.ts`; `.opencode/plugins`
is a discovered plugin dir; `.opencode/plugin` also works):

```ts
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "probe.agent-injection",
  async setup(ctx) {
    await ctx.agent.transform((editor) => {
      editor.update("probe-agent", (agent) => {
        agent.description = "probe agent created via transform"
        agent.mode = "subagent"
      })
    })
  },
})
```

```bash
cd /tmp/omo-v2-agent-probe
OPENCODE_SERVER_PASSWORD=probepw XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg \
  opencode serve --hostname 127.0.0.1 --port 14300 --print-logs > a.log 2>&1 &
# warm up then read
curl -s -u opencode:probepw http://127.0.0.1:14300/api/agent
```

`GET /api/agent` JSON slice (HTTP 200; `probe-agent` present; unauthenticated = HTTP 401):

```json
{"id":"probe-agent","name":"probe-agent","description":"probe agent created via transform",
 "mode":"subagent","hidden":false,
 "permissions":[ ...defaults..., {"action":"external_directory","resource":"/tmp/omo-v2-agent-probe/xdg/opencode/*","effect":"allow"} ]}
```

`GET /api/plugin` confirms the probe plugin is active:
`{"id":"probe.agent-injection","source":{"type":"local","path":".../probe.ts"},"state":{"status":"active"}}`.

A second run (port 14303) set the full field set and removed a built-in agent:

```ts
editor.update("probe-agent-2", (agent) => {
  agent.description = "probe 2 via transform"
  agent.mode = "subagent"
  agent.model = { id: "deepseek-flash", providerID: "litellm", variant: "fast" }
  agent.color = "#0000ff"; agent.steps = 9
  agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
})
editor.remove("title")
```

```json
{"id":"probe-agent-2","name":"probe-agent-2",
 "model":{"id":"deepseek-flash","providerID":"litellm","variant":"fast"},
 "description":"probe 2 via transform","mode":"subagent","hidden":false,
 "color":"#0000ff","steps":9,
 "permissions":[ ...defaults..., {"action":"read","resource":"*","effect":"deny"} ]}
```

Returned ids: `["build","general","explore","compaction","summary","plan","probe-agent-2"]` — `title`
is absent, proving `editor.remove` works.

**Verdict A: ✅ WORKS.** Adds a brand-new agent; sets model, variant, description, mode, color, steps,
hidden, permissions; can override existing and remove. Directly callable from `setup(ctx)`.
(Caveat: `Agent.Info` has no `tools`; use `permissions`.)

---

## 3. Experiment B — V2 config `agents` field

`opencode.json` in the scratch cwd:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "probe-config-agent": {
      "description": "agent from config",
      "model": "litellm/deepseek-flash",
      "mode": "subagent",
      "color": "#ff0000",
      "steps": 7,
      "permissions": [ { "action": "read", "resource": "*", "effect": "allow" } ]
    },
    "probe-config-variant": {
      "description": "agent from config with variant",
      "model": { "providerID": "litellm", "model": "deepseek-flash", "variant": "fast" },
      "mode": "all"
    }
  }
}
```

Command: server on port 14301, same auth/warm-up, then `GET /api/agent`. No config-validation errors in
`b.log`. JSON slices (HTTP 200):

```json
{"id":"probe-config-agent","name":"probe-config-agent",
 "model":{"id":"deepseek-flash","providerID":"litellm"},
 "description":"agent from config","mode":"subagent","hidden":false,
 "color":"#ff0000","steps":7,
 "permissions":[ ...defaults..., {"action":"read","resource":"*","effect":"allow"} ]}

{"id":"probe-config-variant","name":"probe-config-variant",
 "model":{"id":"deepseek-flash","providerID":"litellm","variant":"fast"},
 "description":"agent from config with variant","mode":"all","hidden":false}
```

**Verdict B: ✅ WORKS.** The `agents` record genuinely defines new agents (and overrides built-ins).
Supports model (string and object form), variant, description, mode, hidden, color, steps, request,
system, permissions, `disabled`. No `tools` field (permissions only). Not programmatic by itself —
it is declarative config; a plugin could write it to disk and trigger a reload.

---

## 4. Experiment C — `.opencode/agents/*.md` files

Files created (also tested `.opencode/agent/*.md` and `.opencode/mode/*.md`):

```md
<!-- .opencode/agents/probe-file-agent.md (modern frontmatter) -->
---
description: agent from markdown file
mode: subagent
model: litellm/deepseek-flash
color: "#00ff00"
steps: 3
permissions:
  - action: read
    resource: "*"
    effect: allow
---
You are a probe agent created from a modern markdown file.
```

```md
<!-- .opencode/agent/probe-legacy-agent.md (legacy frontmatter incl. tools) -->
---
description: legacy agent with tools map
mode: subagent
model: litellm/deepseek-flash
tools: { bash: false, read: true }
permission: { edit: deny }
---
legacy body
```

```md
<!-- .opencode/mode/probe-mode-agent.md (mode dir forces primary) -->
---
description: agent from mode dir
---
mode dir body
```

Command: server on port 14302, same auth/warm-up, then `GET /api/agent`. JSON slices (HTTP 200):

```json
{"id":"probe-file-agent","name":"probe-file-agent",
 "model":{"id":"deepseek-flash","providerID":"litellm"},
 "system":"You are a probe agent created from a modern markdown file.",
 "description":"agent from markdown file","mode":"subagent","hidden":false,
 "color":"#00ff00","steps":3,
 "permissions":[ ...defaults..., {"action":"read","resource":"*","effect":"allow"} ]}

{"id":"probe-legacy-agent","name":"probe-legacy-agent",
 "model":{"id":"deepseek-flash","providerID":"litellm"},"system":"legacy body",
 "description":"legacy agent with tools map","mode":"subagent","hidden":false,
 "permissions":[ ...defaults...,
   {"action":"shell","resource":"*","effect":"deny"},   // from tools.bash=false
   {"action":"read","resource":"*","effect":"allow"},   // from tools.read=true
   {"action":"edit","resource":"*","effect":"deny"} ]}  // from permission.edit=deny

{"id":"probe-mode-agent","name":"probe-mode-agent","system":"mode dir body",
 "description":"agent from mode dir","mode":"primary","hidden":false}
```

`all ids: ["build","general","explore","compaction","title","summary","plan","probe-legacy-agent","probe-file-agent","probe-mode-agent"]`

**Verdict C: ✅ WORKS.** Markdown agents are discovered under `{agent,agents}/**/*.md` (mode not
forced) and `{mode,modes}/*.md` (force `primary`). Modern frontmatter supports model/variant/
description/mode/color/steps/permissions; **legacy frontmatter supports `tools`**, which is
translated to `permissions`. Body becomes `system`. Declarative, not programmatic.

---

## 5. Field-support matrix

| Capability | A: `agent.transform` | B: config `agents` | C: `.md` files |
|---|---|---|---|
| Add brand-new agent | ✅ `update(id, fn)` creates | ✅ record entry | ✅ new file |
| Override built-in | ✅ | ✅ (unless `disabled`) | ✅ |
| Remove agent | ✅ `remove(id)` | ✅ `disabled: true` | n/a (delete file) |
| `model` | ✅ object/string | ✅ string or object | ✅ string / `model` |
| `variant` | ✅ `model.variant` | ✅ `model.variant` (or `provider/model#variant`) | ✅ `variant` frontmatter |
| `description` | ✅ | ✅ | ✅ |
| `mode` | ✅ | ✅ | ✅ (forced `primary` under `mode/`,`modes/`) |
| `tools` | ❌ (use `permissions`) | ❌ (use `permissions`) | ✅ legacy `tools` → permissions |
| `permissions` | ✅ push/replace | ✅ | ✅ modern `permissions` or legacy `permission`/`tools` |
| `system` | ✅ | ✅ | ✅ (body) |
| `color` / `steps` / `hidden` / `request` | ✅ | ✅ | ✅ (color/steps/hidden; request via modern schema) |
| Programmatic from `setup(ctx)` | ✅ | ❌ (write config + reload) | ❌ (write files + reload) |

## 6. Programmatic injection from `setup(ctx)` — YES (mechanism A)

`ctx.agent.transform(cb)` returns `Promise<Registration>` (with `dispose()`); `cb` receives an editor
offering `list()`, `get(id)`, `default(id|undefined)`, `update(id, fn)` and `remove(id)`. Because
`update` creates missing ids, a plugin can inject agents at setup:

```ts
async setup(ctx) {
  await ctx.agent.transform((editor) => {
    editor.update("my-omo-agent", (a) => {
      a.description = "..."; a.mode = "subagent"
      a.model = { id: "gpt-4o", providerID: "openai", variant: "high" }
      a.permissions.push({ action: "edit", resource: "*", effect: "deny" })
    })
  })
}
```

Transforms persist and are re-run on `reload`/invalidate (registry re-executes `initial()` + every
registered transform), so injected agents survive reloads until the returned registration is disposed.

## 7. Recommendation

**Use mechanism A — `ctx.agent.transform(editor => editor.update(id, fn))`** for omo agent injection.
It is the only fully programmatic path, works from `setup(ctx)`, supports every `Agent.Info` field
(model incl. variant, description, mode, hidden, color, steps, request, system, permissions), and can
also override built-ins or `remove` agents. Config (`agents`) and markdown (`.opencode/agents/*.md`)
remain valid **declarative** fallbacks and both funnel through the same editor, so omo could emit them
if a plugin-free deployment is ever needed — at the cost of writing files/config and triggering a
reload.

### Evidence artifacts (scratch, `/tmp/omo-v2-agent-probe/`)
- `a.log`, `a2-agent.json`, `a3-agent.json` — mechanism A (plugin transform)
- `b.log`, `b-agent.json` — mechanism B (config `agents`)
- `c.log`, `c-agent.json` — mechanism C (markdown files)
- `run.sh`, `probe.sh` — launch/read harness used above

---

## 8. P1 验证结果（Task 3：V2 实机验证 + 回归）

- **最终代码**: HEAD `0b9bd8e`（`fix(v2): merge agent request instead of replacing it`），在初验
  `19d1cac` 之后修复。
- **结论（修复后）**：omo agents 注册进 V2 并可通过 HTTP 读取。`GET /api/agent` 返回 **HTTP 200**，
  共 **16** 个 agent（10 个 omo：9 新增 + 覆盖 builtin `explore`）；`GET /api/agent/oracle` 返回
  **HTTP 200**，`oracle.request = {settings:{},headers:{},body:{temperature:0.1}}`。
- **历史（保留记录）**：初次验证（HEAD `19d1cac`）在此**阻塞**——`GET /api/agent` 返回 HTTP 400
  `InvalidRequestError: Missing key at ["data"][3]["request"]["settings"]`，`GET /api/agent/oracle`
  同样 400（`InvalidRequestError: Missing key at ["data"]["request"]["settings"]`）。根因是
  `toV2AgentInfo` 产出 `request: { body }`，且 `register-agents.ts` 用 `Object.assign` **整体替换**
  了 V2 预置的 `request`，丢掉必需的 `settings`/`headers`。commit `0b9bd8e` 已修复（见 §8.5）。

### 8.1 构建 index bundle

```bash
cd /home/user/omo-v2 && export PATH="$HOME/.bun/bin:$PATH"
bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm \
  --external zod --external @opencode/plugin
# -> Bundled 1980 modules in 217ms ; dist/index.js 5.75 MB
```

### 8.2 隔离 scratch 启动命令

```bash
cd /tmp/omo-v2-agent-probe
cat > opencode.json <<'JSON'
{ "$schema": "https://opencode.ai/config.json" }
JSON
cat > .opencode/plugins/omo-local.ts <<'TS'
export { default } from "/home/user/omo-v2/dist/index.js"
TS
OPENCODE_SERVER_PASSWORD=probepw XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg \
  opencode serve --hostname 127.0.0.1 --port 14310 --print-logs > /tmp/omo-v2-agent-probe/p1.log 2>&1 &
# readiness: GET /api/info -u opencode:probepw -> 200 (2s)
# read:      GET /api/agent   -u opencode:probepw
```

`opencode --version` = **2.0.11**；`@opencode/plugin` = **2.0.11**；Bun **1.3.14**；
用户全局 config 未触碰（仅 `XDG_CONFIG_HOME=/tmp/omo-v2-agent-probe/xdg`）。
插件加载日志确认生效：`msg="loading plugin" id=.../omo-local.ts`（`p1.log:15`）。

### 8.3 Agent 列表与 omo agent（raw：`GET /api/agent`，HTTP 200）

修复后列表端点可用。`/tmp/omo-v2-agent-probe/p1-final-agent.json`（130409 bytes）：

```json
{"location":{"directory":"/tmp/omo-v2-agent-probe"},"data":[{"id":"Sisyphus - ultraworker", "...":"..."}, "..."]}
```

**总数 = 16**；builtin = 7（`build, general, explore, compaction, title, summary, plan`）；
**omo = 10**（9 个新增 + 覆盖 builtin `explore`）：

```text
Sisyphus - ultraworker      mode=primary  model=litellm/deepseek-flash
Prometheus - Plan Builder   mode=primary  model=litellm/deepseek-flash
Atlas - Plan Executor       mode=primary  model=new-api/kimi-k2.6
librarian                   mode=subagent model=litellm/deepseek-flash
Metis - Plan Consultant     mode=subagent model=litellm/deepseek-flash
Momus - Plan Critic         mode=subagent model=litellm/deepseek-flash
multimodal-looker           mode=subagent model=new-api/kimi-k2.7-code
oracle                      mode=subagent model=new-api/kimi-k2.7-code
Sisyphus-Junior             mode=subagent model=litellm/deepseek-flash
explore (覆盖 builtin)       mode=subagent model=litellm/deepseek-flash
```

说明：brief 列出的 `hephaestus` 未出现；`atlas`/`prometheus` 的 V1 显示名分别为
`Atlas - Plan Executor` / `Prometheus - Plan Builder`。`explore` 命中了 V2 builtin 同名 id，
被 omo 的 explore 覆盖（permissionCount=31）。

### 8.4 oracle 条目（raw slice，`GET /api/agent/oracle` HTTP 200）

```json
{
  "id": "oracle",
  "name": "oracle",
  "mode": "subagent",
  "hidden": false,
  "model": { "id": "kimi-k2.7-code", "providerID": "new-api" },
  "request": { "settings": {}, "headers": {}, "body": { "temperature": 0.1 } },
  "permissions": [ ...默认 5 条 + external_directory 白名单 +
    {"action":"edit","resource":"*","effect":"deny"} +
    {"action":"task","resource":"*","effect":"deny"} ]
}
```

（观察：oracle 未带 `variant`；`model` 为 `new-api/kimi-k2.7-code`。修复后 `GET /api/agent` 列表中
全部 16 个 agent 的 `request` 均含 `settings`/`headers`/`body` 三键；此前受影响的 8 个 agent 现在都
带完整 request，例如 `Metis - Plan Consultant` 的 `body={temperature:0.3}`，
`librarian`/`Atlas - Plan Executor`/`multimodal-looker`/`oracle`/`Sisyphus-Junior` 为
`{temperature:0.1}`。）

### 8.5 根因与修复：`request` 由整体替换改为 merge

**初验失败（HEAD `19d1cac`）的原始输出**（`p1-agent.json` / `p1d-oracle.txt`）：

```json
{"_tag":"InvalidRequestError","message":"Missing key\n  at [\"data\"][3][\"request\"][\"settings\"]","kind":"Body"}
{"_tag":"InvalidRequestError","message":"Missing key\n  at [\"data\"][\"request\"][\"settings\"]","kind":"Body"}
```

`p1.log` 佐证：`level=WARN message="schema rejection" kind=Body reason="Missing key ... [\"data\"][3][\"request\"][\"settings\"]"`。

`Agent.Info` schema 要求 `request: { settings, headers, body }` 三个键（见 §1.2）。`agent-mapping.ts:54-57`
产出 `out.request = { body }`，而 `register-agents.ts` 用 `Object.assign(agent, rest)` 把
editor 预置的合法 `request`（`Agent.Info.default` 的 `{settings:{},headers:{},body:{}}`）**整体覆盖**。
对照 §1.4：built-in `opencode.config.agent` 的写法是 **merge**
（`Object.assign(Q.request.headers, ...)` + `Object.assign(Q.request.body, ...)`），从不替换 `request` 对象。

**修复**（commit `0b9bd8e`）：`register-agents.ts` 把 `request` 从 mapped payload 中解构出来，改为把
`settings`/`headers`/`body` **合并**进 seeded request：

```ts
const { permissions: incoming, request: incomingRequest, ...rest } = mapped
Object.assign(agent, rest)
if (incomingRequest !== undefined) {
  const prev = (agent.request ?? {}) as { settings?; headers?; body? }
  const next = (incomingRequest ?? {}) as typeof prev
  agent.request = {
    settings: { ...(prev.settings ?? {}), ...(next.settings ?? {}) },
    headers:  { ...(prev.headers  ?? {}), ...(next.headers  ?? {}) },
    body:     { ...(prev.body     ?? {}), ...(next.body     ?? {}) },
  }
}
```

修复后 `GET /api/agent` = HTTP 200，日志中不再出现 `schema rejection`。

### 8.6 失败串计数（`p1-final.log`，修复后）

```text
grep -c "failed to load plugin" p1-final.log               -> 0
grep -c "must export a default definition" p1-final.log    -> 0
grep -c "schema rejection" p1-final.log                    -> 0
```

插件加载无失败；修复后也不再出现 response schema rejection。

### 8.7 回归（修复后，HEAD `0b9bd8e`）

```text
bun test packages/omo-opencode/src/v2/ packages/omo-opencode/src/index.export-shape.test.ts
  -> 19 pass, 0 fail, 86 expect() calls, 4 files (1353ms)

npx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
  -> exit=0 (无输出)
```

注：初验在 `19d1cac` 为 47 expect calls；`0b9bd8e` 增加了 request-merge 的回归断言，故升至 86。

### 8.8 证据文件（scratch，`/tmp/omo-v2-agent-probe/`）

修复后：
- `p1-final.log` — 启动日志（插件加载，无 WARN/schema rejection）
- `p1-final-agent.json` — `GET /api/agent` HTTP 200（16 agents，130409 bytes）
- `p1-final-oracle.json` — `GET /api/agent/oracle` HTTP 200
- `transform-dump.json` — `AgentEditor.list()` 注册表快照（16 agents，10 omo）
- `task3-final.sh` — 启动/取证脚本

初验（阻塞于 `request.settings` 400，保留）：
- `p1.log` — 含 `schema rejection`
- `p1-agent.json` / `p1d-agent-call2.txt` / `p1d-oracle.txt` — HTTP 400 原始输出
- `p1d-agent-call1.txt` — 首次调用冷启动空列表 `{"location":...,"data":[]}`（HTTP 200）
- `p1d-sisyphus.txt` — `GET /api/agent/Sisyphus - ultraworker` HTTP 200
- `baseline-agent.json` / `baseline.log` — 无插件基线（HTTP 200，7 builtin）
- `task3-run.sh`, `task3-dump.sh`, `task3-single2.sh` — 初验脚本
