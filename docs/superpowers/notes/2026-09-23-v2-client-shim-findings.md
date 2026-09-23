# V1 `client` shim from V2 plugin domain APIs — findings (2026-09-23)

> P2.5 pre-work spike. Question: **can a V1-SDK-shaped `client` be reproduced from OpenCode
> V2's plugin `Context` domains, to unlock the tools currently skipped by
> `CLIENT_DEPENDENT_TOOLS`?**
>
> Status: **partially — a shim can cover the read/prompt/abort/create surface (5 of the 11
> methods directly, +2 with small adaptation), but V2's `ctx.session` exposes only a `Pick`
> of the client, so `list`/`todo`/`status`/`summarize`/`children` and `tui.showToast` have
> no domain equivalent.** Realistic unlock is narrow; details below.

## 0. Environment / method / evidence

- `opencode --version` → **2.0.11**; `@opencode/plugin@2.0.11`; `@opencode/client@2.0.11`;
  Bun 1.3.14. Probe root `/tmp/omo-v2-client-probe`, `XDG_CONFIG_HOME` isolated,
  `OPENCODE_SERVER_PASSWORD=probepw` (Basic `opencode:probepw`), port 14500.
- Probe plugin: `/tmp/omo-v2-client-probe/.opencode/plugin/client-probe.ts` (reflection +
  read-only calls only). Raw evidence: `/tmp/omo-v2-client-probe/domains.json`,
  `/tmp/omo-v2-client-probe/calls.json`.
- **Operational gotcha (confirmed):** plugins load lazily — starting `opencode serve` alone
  does *not* run `setup(ctx)`. A warm-up `GET /api/info` (HTTP 200) is required, after which
  `setup()` runs. `/api/plugin` before warm-up is empty even for built-ins. (`domains.json`
  only appeared after warm-up/reload.)

## 1. What V2 actually exposes (reflected, not read from docs)

`Object.keys(ctx)` = `agent, aisdk, app, command, event, experimental, generate, integration,
location, mcp, model, options, permission, plugin, provider, reference, rpc, session, shell,
skill, storage, tool, vcs, websearch, worktree`.

**Absent:** `client`, `tui`, `server`, `message`, `config`.

```json
"session": { "keys": ["command","context","create","generate","get","hook","interrupt",
  "move","prompt","switchAgent","switchModel","synthetic","update","wait"] }
"app":     { "keys": ["channel","name","version"] }            // static metadata
"tui":     undefined
```

This is exactly `SessionDomain = Pick<SessionApi, "create"|"get"|"switchAgent"|"switchModel"|
"prompt"|"generate"|"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context">`.
The underlying `SessionApi` also has `list`, `stats`, `active`, `message.get`, `compact`,
`inbox`, `diff`, `children`… **but the V2 plugin Context never exposes them.**

Runtime `ctx.app` value: `{ name: "cli", version: "2.0.11", channel: "latest" }`.

Real read-only calls that succeeded (evidence `calls.json`):

| Call | Result |
|---|---|
| `ctx.session.get({sessionID})` | `SessionInfo` object: `id,parentID,projectID,agent,model,cost,tokens,time,title,location` |
| `ctx.session.context({sessionID})` | `SessionMessageInfo[]` (86 items in probe; each `{type,id,time,…}`; user items have `text`, assistant items have `content`) |
| `ctx.agent.list({})` | `{location, data:[AgentInfo,…]}` |
| `ctx.skill.list({})` | `{location, data:[SkillInfo,…]}` |
| `ctx.model.list({})` | `{location, data:[ModelInfo,…]}` |

Negative controls: `session.messages/todo/status/summarize/promptAsync/abort/children` and
`tui.showToast` are all `typeof === "undefined"`; a deep scan of `ctx` found no hidden
`client`/full `SessionApi` anywhere.

## 2. Per-method verdict

| V1 `client` usage | call sites | V2 domain | verdict |
|---|---|---|---|
| `session.get` | 22 | `ctx.session.get({sessionID})` | **Direct** (V1 `{data:Session}` vs V2 plain `SessionInfo`) |
| `session.create` | 4 | `ctx.session.create({…})` | **Direct** (V1 `{data:Session}` vs V2 `SessionInfo`) |
| `session.abort` | 6 | `ctx.session.interrupt({sessionID})` → `{interrupted:boolean}` | **Direct, shape delta** (V1 returns boolean) |
| `session.promptAsync` | 7 | `ctx.session.prompt({sessionID,text,…})` → `SessionInboxUser` | **Direct, shape delta** — V1 takes `{path:{id},body:{parts:[…]}}` and returns 204; V2 takes `{sessionID,text,…}` and returns the accepted inbox item. The internal prompt gate expects `{status:"accepted"}` → shim must translate. |
| `session.messages` | 46 | `ctx.session.context({sessionID})` | **Adaptation** — V1 `{data:[{info:Message,parts:Part[]}]}`; V2 `SessionMessageInfo[]` (flat, typed items). Callers read `.data`, `message.info.role/id/time`, `message.parts`. Shim must rebuild `{info,parts}` or the call sites must be rewritten. |
| `session.status` | 8 | none on `ctx.session` | **No domain equivalent.** V2 has `session.active`/`inbox` on the client but not on ctx. Usable only as a *stub*: `look_at` feature-detects `status` and falls back to messages; `call_omo_agent`/`delegate-task` call it unguarded but treat an empty map as “not active” and fall back to message-count stability. |
| `session.summarize` | 27 | none on `ctx.session` (`compact` exists on `SessionApi`, not exposed) | **No domain equivalent.** |
| `session.todo` | 14 | none | **No V2 equivalent at all** (V2 removed todos; no todo in `SessionInfo`/`SessionMessageInfo`). |
| `session.children` | 2 | none (`session.list({parentID})` not exposed) | **No domain equivalent.** |
| `tui.showToast` | 6 | none (`ctx.tui` absent) | **No V2 equivalent in the server plugin context** — TUI plugins are a separate `@opencode/plugin/tui` surface (P5). |
| `app` / `app.agents` | 1 / 7 | `ctx.agent.list()` | **Adaptation** — V1 `{data:Agent[]}` vs V2 `{location,data:AgentInfo[]}`. |
| `config.get` (skill/runtime) | — | none | **No `config` domain in ctx.** `ctx.skill.list()` covers the skills-specific need; general config has no equivalent. |
| `model.list` / `provider.list` | 3 | `ctx.model.list()` / `ctx.provider.list()` | **Direct, shape delta** (`{location,data:[…]}`). |
| `event.subscribe` | — | `ctx.event.subscribe(...)` | **Adaptation** (V2 event envelope differs). |
| `_client` (raw generated SDK, used by `native-skills`) | — | none | **No equivalent.** |

## 3. No V2 equivalent → affected tools + degradation plan

| Missing V1 method | Affected tools | Degradation plan |
|---|---|---|
| `session.todo` | `session_read`, `session_info` (todo-sync in `task_create`/`task_update`) | Drop todo surface; read tasks from `session.context` heuristically, or leave disabled until V2 gains a todo API. |
| `session.status` | `call_omo_agent`, `look_at`, `task` | Stub `status()` returning `{}` / derive from `ctx.event.subscribe` (`session.execution.*`) + `ctx.session.wait`. All three call sites degrade to message-count polling. |
| `session.summarize` | (config/compaction helpers) | No shim path; keep disabled until V2 exposes `session.compact` to plugins. |
| `session.list` / `session.children` | `session_list`, `session_read`, `session_search`, `session_info` | No domain equivalent. Note: `session-manager` has a **filesystem fallback** that works when no SDK client is set, so these may be unlockable *without* a shim (denylist is conservative) — needs separate verification. |
| `tui.showToast` | toast/UX paths | Defer to P5 (TUI plugin surface). |
| `config.get` / raw `_client` | `skill`, `skill_mcp`, `native-skills` | `ctx.skill.list()` substitutes for runtime skills; `ctx.ask` remains fail-closed in the V2 ToolContext (independent of the client shim). |

## 4. Unlock estimate

- Code denylist: `CLIENT_DEPENDENT_TOOLS` = **29 names**.
- **Default registry actually skips 11** (confirmed by the P2 live probe; the plan's “14” is
  not supported by the code — closest reading is 11 skipped + 3 registered client-free tools):
  `background_cancel, background_output, call_omo_agent, look_at, session_info, session_list,
  session_read, session_search, skill, skill_mcp, task`.
- A `createV1ClientShim(ctx)` over the exposed domains can serve:
  `get, create, promptAsync→prompt, abort→interrupt, messages→context` (+`status` stub,
  `config.get` stub, `app.agents→agent.list`, `model.list`, `event.subscribe`).
- **Tools realistically unlocked: 5 of 11** —
  `background_cancel` (client-free; unlockable without a shim),
  `background_output` (`messages` only),
  `call_omo_agent`, `look_at`, `task` (`messages/get/create/prompt/abort` + `status` stub,
  with graceful fallbacks already present in the call sites).
- **Still blocked: 6 of 11** — the four `session_*` tools (`list`/`todo`) and
  `skill`/`skill_mcp` (`ctx.ask` ToolContext gap + `config.get`/`_client`).
- Verdict: a shim is a **narrow win** — worth it only as a small translation layer for the
  message/prompt surface; it is **not** a general “restore the V1 client” solution. The
  higher-leverage fix for `session_*` is the existing filesystem fallback; `skill*` is blocked
  by `ctx.ask`, not by the client.

## 5. Caveats

- No mutating method was invoked (`create`/`prompt`/`interrupt`/`compact` were only
  reflected/typed). Their shapes come from `@opencode/client@2.0.11` generated types.
- `session.status` “derivable from events” is an inference; the probe did not exercise it.
- Escape hatch (out of scope): a plugin can construct its own `@opencode/client` and call the
  local HTTP API for missing methods, but self-calls during plugin load deadlock (the
  `runtime-skill-resolver` doc records this); only safe at tool-execute time and fragile.
