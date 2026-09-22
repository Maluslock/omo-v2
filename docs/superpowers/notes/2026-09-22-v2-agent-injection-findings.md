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
