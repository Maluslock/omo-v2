# V1 `client` shim from V2 plugin domain APIs — findings (2026-09-23)

> P2.5 pre-work spike. Question: **can a V1-SDK-shaped `client` be reproduced from OpenCode
> V2's plugin `Context` domains, to unlock the tools currently skipped by
> `CLIENT_DEPENDENT_TOOLS`?**
>
> Status: **partially — across the 12 V1 methods used by omo (the plan's 11 + sync
> `session.prompt`), 5 map directly (`get`, `create`, `abort`, `promptAsync`, `prompt`), 2 need
> adaptation (`messages`, `app.agents`), and 5 have no V2 domain equivalent (`todo`, `status`,
> `summarize`, `children`, `tui.showToast`).** V2's `ctx.session` exposes only a `Pick` of the
> client, so `list`/`todo`/`status`/`summarize` are unreachable. Shim-attributable unlock:
> **5 of the 11 skipped tools** (details below).

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
`inbox`, `diff`, … — **but the V2 plugin Context never exposes them.** It has **no `children`
method**: the V1 `session.children` route maps to `session.list({ parentID })`
(`SessionListInput.parentID`, `@opencode/client` generated `types.d.ts:3551`).

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

| V1 `client` usage | sites | V2 domain | verdict |
|---|---|---|---|
| `session.get` | 22 | `ctx.session.get({sessionID})` | **Direct** (V1 `{data:Session}` vs V2 plain `SessionInfo`) |
| `session.create` | 4 | `ctx.session.create({…})` | **Direct** (V1 `{data:Session}` vs V2 `SessionInfo`) |
| `session.abort` | 6 | `ctx.session.interrupt({sessionID})` → `{interrupted:boolean}` | **Direct, shape delta** (V1 returns boolean) |
| `session.promptAsync` | 7 | `ctx.session.prompt({sessionID,text,…,delivery})` | **Direct, shape delta + delivery** — V1 `{path:{id},body:{parts:[…]}}` returns 204; V2 `{sessionID,text,…}` returns `SessionInboxUser`. Missing from a shim, the internal gate returns `{status:"unavailable"}`. |
| `session.prompt` (sync) | indirect (gate `mode:"sync"`; no direct call sites) | `ctx.session.prompt({sessionID,text,…,delivery})` | **Direct, shape delta + delivery** — same V2 method as `promptAsync`, different intent (see §4). Required by `look_at` and `call_omo_agent` sync paths. |
| `session.messages` | 46 | `ctx.session.context({sessionID})` | **Adaptation** — V1 `{data:[{info:Message,parts:Part[]}]}`; V2 `SessionMessageInfo[]` (flat, typed items). Callers read `.data`, `message.info.role/id/time`, `message.parts`. Shim must rebuild `{info,parts}` or the call sites must be rewritten. |
| `session.status` | 8 | none on `ctx.session` | **No domain equivalent.** Usable only as a *stub*: `look_at` feature-detects `status` and falls back to messages; `call_omo_agent`/`delegate-task` call it unguarded but treat an empty map as “not active” and fall back to message-count stability. |
| `session.summarize` | 27 | none on `ctx.session` (`compact` exists on `SessionApi`, not exposed) | **No domain equivalent.** |
| `session.todo` | 14 | none | **No V2 equivalent at all** (V2 removed todos; no todo in `SessionInfo`/`SessionMessageInfo`). |
| `session.children` | 2 | `session.list({parentID})` — not exposed | **No domain equivalent.** |
| `tui.showToast` | 6 | none (`ctx.tui` absent) | **No V2 equivalent in the server plugin context** — TUI plugins are a separate `@opencode/plugin/tui` surface (P5). |
| `app` / `app.agents` | 1 / 7 | `ctx.agent.list()` | **Adaptation** — V1 `{data:Agent[]}` vs V2 `{location,data:AgentInfo[]}`. |
| `config.get` (skill/runtime) | — | none | **No `config` domain in ctx.** `ctx.skill.list()` covers the skills-specific need; a `config.get` stub that returns `{}` also satisfies `readRuntimeHostSkills` (it is wrapped in try/catch and falls back to base skills). |
| `model.list` / `provider.list` | 3 | `ctx.model.list()` / `ctx.provider.list()` | **Direct, shape delta** (`{location,data:[…]}`). |
| `event.subscribe` | — | `ctx.event.subscribe(...)` | **Adaptation** (V2 event envelope differs). |
| `_client` (raw generated SDK, used by `native-skills`) | — | none | **No equivalent.** |

## 3. No V2 equivalent → affected tools + degradation plan

| Missing V1 method | Affected tools | Degradation plan |
|---|---|---|
| `session.todo` | `session_read`, `session_info` (todo-sync in `task_create`/`task_update`) | Drop todo surface; read tasks from `session.context` heuristically, or leave disabled until V2 gains a todo API. |
| `session.status` | `call_omo_agent`, `look_at`, `task` | Stub `status()` returning `{}` / derive from `ctx.event.subscribe` (`session.execution.*`) + `ctx.session.wait`. All three call sites degrade to message-count polling. |
| `session.summarize` | (config/compaction helpers) | No shim path; keep disabled until V2 exposes `session.compact` to plugins. |
| `session.list` / `session.list({parentID})` | `session_list`, `session_read`, `session_search`, `session_info` | No domain equivalent. Note: `session-manager` has a **filesystem fallback** (`tools/session-manager/storage.ts`: SDK path only when `sdkClient` is set, else `getFileMainSessions`) so these may be unlockable *without* a shim — needs separate verification. |
| `tui.showToast` | toast/UX paths | Defer to P5 (TUI plugin surface). |
| `config.get` | `skill_mcp` (soft), `native-skills` | Stub `config.get()` returning `{}`; `readRuntimeHostSkills` falls back to base skills. |
| raw `_client` | `native-skills` | No equivalent; native-skills is V2-SDK-specific. |

**`skill` vs `skill_mcp` (corrected):** `tools/skill/tools.ts:153` is the only caller of
`ctx.ask(...)`. `tools/skill-mcp/tools.ts` never calls `ask`; it depends on
`getLoadedSkills()` → `readRuntimeHostSkills(client)` → `client.config.get()` (try/catch,
base-skills fallback) and on `toolContext.directory` (supplied by the V2 tool adapter at
`v2/tool-mapping.ts:162`, not by the client). So `skill_mcp` is **unlockable** via the shim
(or even client-free), while `skill` is blocked by the V2 ToolContext `ask` gap
(`v2/tool-mapping.ts:171-174` rejects when no `opts.ask` resolver is supplied) — independent
of the client shim.

## 4. Prompt dispatch semantics (corrected)

`look_at-session-runner.ts:65` and `call-omo-agent/sync-executor.ts:138-144` call
`promptSyncWithModelSuggestionRetry` / `dispatchInternalPrompt({mode:"sync"})`, which requires
**`session.prompt`**; `delegate-task` (`promptWithModelSuggestionRetry`) uses
`{mode:"async"}`, which requires **`session.promptAsync`**. If either function is absent,
`dispatchInternalPrompt` returns `{status:"unavailable"}` (`packages/utils/src/prompt-async-gate.ts:190-193`).
So the shim must provide **both** `session.prompt` and `session.promptAsync`.

The dispatch result is **not** a fixed `{status:"accepted"}` contract: the gate returns its own
`"dispatched" | "queued" | "reserved" | "unavailable" | "failed"` values and
`isInternalPromptDispatchAccepted` accepts only `"dispatched" | "queued"`
(`packages/utils/src/prompt-async-gate.ts:307`); the V1 client's prompt return value is passed
through opaquely (`dispatchInternalPrompt` returns the awaited dispatch result). The shim does
not need to synthesize any `status`.

**Delivery choice (V2 requires it):** the V2 hook type requires
`delivery: SessionInbox.Delivery` (`@opencode/plugin/dist/promise/session.d.ts:18`) while the
client input is optional (`delivery?: "steer" | "queue" | null`,
`@opencode/client` generated `types.d.ts:5324,5368`). Recommended shim mapping:

- `session.promptAsync` (async, fire-and-forget; default gate behavior `enqueue`) →
  `delivery: "queue"` — enqueue rather than steer any in-flight turn.
- `session.prompt` (sync, `queueBehavior:"defer"`): the gate first waits for session idle
  (`dispatchAfterSessionIdle`) before calling, so there is no running turn to steer; use
  `delivery: "steer"` to run immediately (if idle cannot be guaranteed, `"queue"` is the safe
  fallback). This mapping is inferred from the `"steer"`/`"queue"` names + gate ordering; it
  was not runtime-verified in this spike.

## 5. Unlock estimate (corrected)

- Code denylist: `CLIENT_DEPENDENT_TOOLS` (`src/v2/register-tools.ts:39`) = 29 names.
- **Default registry: 3 registered + 11 skipped = 14 tools** — this is the origin of the
  plan's “14”: `omo_glob`, `omo_grep`, `omo_interactive_bash` registered; the 11 skipped are
  `background_cancel, background_output, call_omo_agent, look_at, session_info, session_list,
  session_read, session_search, skill, skill_mcp, task`.
- **Shim-attributable unlock: 5 of 11** —
  `background_output` (`messages` only),
  `call_omo_agent` (`get/create/messages/abort` + `prompt` sync + `status` stub),
  `look_at` (same + `prompt` sync; `status` guarded),
  `task` (`messages/get/create/abort` + `promptAsync` + `model.list` + `app.agents→agent.list`
  + `config.get` stub; `status`/`config.get` call sites already guarded),
  `skill_mcp` (`config.get` stub / base-skills fallback; `directory` supplied by the adapter).
- **Unlockable without the shim: 1** — `background_cancel` (its `_client` argument is unused
  in `tools/background-task/create-background-cancel.ts`).
- **Still blocked: 5** — `session_list`, `session_read`, `session_search`, `session_info`
  (need `session.list`/`todo`; may unlock via the filesystem fallback, not via this shim) and
  `skill` (ToolContext `ask` gap, not the client).
- Of the 14-tool registry: **3 already registered + 5 shim-attributable + 1 client-free = 9
  usable**; 5 remain blocked.
- Verdict: a shim is a **narrow win** — worth it as a small translation layer for the
  message/prompt surface, but it is **not** a general “restore the V1 client” solution.

## 6. Wiring point for `createV1ClientShim(ctx)`

`register-tools.ts` constructs the tool registry with a **client-less ctx**:
`getManagers` passes `ctx: { directory } as never` (`src/v2/register-tools.ts:168`) and
`createTools` receives `ctx: { directory } as never` (`:220`); the skip is applied at the
`CLIENT_DEPENDENT_TOOLS.has(name)` check (`:233`). To use a shim:

1. Build `const shim = createV1ClientShim(ctx)` inside `registerOmoTools`.
2. Pass `ctx: { directory, client: shim }` to `getManagers` (`:168`) and `createTools`
   (`:220`) so `createManagers`/`createToolRegistry`/`setStorageClient` receive it.
3. Remove the shim-capable names from `CLIENT_DEPENDENT_TOOLS` (or gate them on shim
   capability), keeping the genuinely unmappable ones (`session_*`, `skill`).

## 7. Caveats

- No mutating method was invoked (`create`/`prompt`/`interrupt`/`compact` were only
  reflected/typed). Their shapes come from `@opencode/client@2.0.11` generated types.
- `session.status` “derivable from events” is an inference; the probe did not exercise it.
- The `delivery` mapping in §4 is inferred, not runtime-verified.
- Escape hatch (out of scope): a plugin can construct its own `@opencode/client` and call the
  local HTTP API for missing methods, but self-calls during plugin load deadlock (the
  `runtime-skill-resolver` doc records this); only safe at tool-execute time and fragile.
