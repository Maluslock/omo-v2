# omo on OpenCode V2 — full functional parity plan (2026-09-24)

Status: planning + in progress. Supersedes the gap sections of
`docs/superpowers/notes/2026-09-23-v2-alignment-audit.md` (**that audit under-counted V2's surface:
it treated several hooks as "no V2 equivalent" when V2 exposes them under different names**).

## 0. Why this plan exists

The user's requirement is **full functional parity** with the V1/original omo, not "mostly works".
So every V1 capability needs either a V2-native mechanism or an explicit "needs upstream" verdict
with evidence. This document is that mapping, derived from the installed type surface
(`@opencode/plugin@2.0.11`) and from live probes.

## 1. Authoritative V2 plugin surface (measured, not assumed)

`Context` (`node_modules/@opencode/plugin/dist/promise/plugin.d.ts`) exposes:

```
app{name,version,channel}  options  location
agent  command  mcp  model  provider  skill  tool  integration  reference  vcs  worktree   <- transform editors
session  permission  shell  aisdk                                                          <- hooks
event  rpc  storage  generate  websearch  plugin  experimental{terminal}
```

Hook points (the part the earlier audit got wrong):

| domain | hooks |
|---|---|
| `session` | `prompt`, `context`, `compaction`, `generate`, `title`, **`model.request`** (mutable `baseURL` + `headers`), **`http.request`**, **`http.response`**, `retry`, `experimental.ws.{handshake,send,receive}` |
| `tool` | `execute.before`, `execute.after` |
| `shell` | **`create.before`** (mutable `command`, `cwd`, `timeout`, `shell`, `env`) |
| `permission` | **`evaluate`** |
| `aisdk` | **`sdk`** (`{model, package, options, sdk?}`), **`language`** (`{model, sdk, options, language?}`) |

Non-hook capabilities we had not used: `ctx.generate` (plugin-side model calls), `ctx.worktree`,
`ctx.vcs`, `ctx.reference`, `ctx.integration.connection.active/resolve` (real credential/connection
lookup), `ctx.rpc`, `ctx.storage`, `ctx.experimental.terminal`.

Not available to plugins (checked at runtime, not only in types): session enumeration
(`ctx.session` key set is `hook, create, get, switchAgent, switchModel, prompt, generate, command,
synthetic, interrupt, update, move, wait, context`), and there is no `session.skill`.

## 2. Per-capability mapping

### Hooks (V1 entry -> V2 mechanism)

| V1 hook | V2 mechanism | status |
|---|---|---|
| `chat.message` | `session.hook("prompt")` | done |
| `experimental.chat.messages.transform` / `system.transform` | `session.hook("context")` | done |
| `tool.execute.before/after` | `tool.hook("execute.before/after")` | done |
| `experimental.session.compacting` | `session.hook("compaction")` | done |
| `event` | `ctx.event.subscribe` | done |
| `chat.headers` (Copilot `x-initiator`) | `session.hook("model.request")` -> mutable `headers` | **P5-A1, not wired** |
| `chat.params` (temperature/topP/topK/maxOutputTokens) | `aisdk.hook("sdk"/"language")` `options` (raw AI-SDK layer) | **P5-A2, not wired** |
| `chat.params` agent variant / thinking / effort | same aisdk options; needs a live probe to find which key carries them | **P5-A2, needs probe first** |
| `permission` (V1 `ctx.ask`) | `permission.hook("evaluate")` + `permission.list/get/reply` | **P5-A3** |
| shell guards (`interactive_bash`, bash read guard) | `shell.hook("create.before")` | **P5-A4** |
| `experimental.compaction.autocontinue` | `session.hook("compaction")` output + post-compaction prompt via the gate | **P5-A5** |
| `tool.definition` (todo description override) | candidates: `aisdk.hook("language")` tool list rewrite, or `session.hook("http.request")` body patch | **P5-A6, low value, verify or record as unportable** |
| `command.execute.before` (auto-slash-command interception) | none needed: commands are now real V2 commands; the V1 interception only existed because V1 could not register commands | **closed** |

### Tools

| V1 tool | mechanism | status |
|---|---|---|
| `grep`, `glob`, `look_at`, `interactive_bash`, `background_output/cancel`, `call_omo_agent`, `task`, `skill_mcp` | registered (V1 bodies + client shim) | done |
| `session_read` | shim `session.messages` via `ctx.session.context` | done (`0892185`) |
| `session_list` / `session_search` / `session_info` | no server-plugin enumeration exists in ANY version. Web research (source-verified): `@opencode/plugin` 2.0.11 and 2.0.15 are byte-identical in `dist/promise/session.d.ts`, `ctx.session` still excludes `list`, three PRs proposing it are open/closed-unmerged (#46690 open), and `ctx.rpc` is not a generic host proxy (`rpc.call` is not attached; only `rpc.register`). **Two viable paths**: (A) omo keeps its own session index in `ctx.storage` (probe-verified: storage persists across restarts; `session.*` events carry `sessionID`), fed by `ctx.event.subscribe` + `session.hook("prompt")`; (B) ship a **TUI companion plugin**, whose shipped context DOES expose `context.data.session.list()` and `context.client` (full client) in 2.0.11. | **A now, B for exact/backfill** |
| `skill` | omo's own tool is skipped, but the V2 host ships its own `skill` tool and loads omo-registered skills (`→ Skill "git-master"` -> `SKILL_OK`). Re-adding omo's version needs the `ask` gap solved, which `permission.hook("evaluate")` now makes possible. | capability covered; **P5-A3 optional** |
| `task_create` / `task_update` | V2 removed host todos. Re-implement the per-session task store on `ctx.storage` and keep the tool contract; `todo-sync` becomes a no-op. | **P6-B2 (rewrite)** |
| `monitor_*` | monitor spawns commands; `ctx.shell` only has a hook, so the manager needs its own process spawning (Node/Bun) + output ring. Harness-neutral parts live in the repo already. | **P6-B3 (rewrite)** |
| `team_*` (12) | runtime primitives are harness-neutral (`packages/team-core`); the missing link is "spawn member session + send prompt + read result", and **`ctx.session.create/prompt/context` all exist**. Worktree orchestration can use `ctx.worktree`, git probes `ctx.vcs`. | **P6-B4 (rewrite, largest)** |

### Other

| item | status |
|---|---|
| provider / connected-providers filtering | the earlier "not implementable" verdict was based on `activation` being the only signal. **`ctx.integration.connection.active(integrationID)` + `resolve(connection)` give real connection/credential state**, and `ProviderInfo.integrationID` links provider -> integration. Re-assess and implement. **P5-A7** |
| `chat.headers` (Copilot initiator) | **`session.hook("model.request")` is mutable and carries `kind` + `agent` + `model.variant`** (live probe `live-v2-hook-surface.jsonl`). Auxiliary requests (`kind: "title"`) must be skipped. | **P5-A1 confirmed portable** |
| `chat.params` generation options | no field on `model.request`; the `aisdk.hook("sdk"/"language")` options are the intended home but **did not fire** in the probe for an `aisdk:@ai-sdk/openai-compatible` provider. Needs a further probe (ordering / package kind). | **P5-A2 open question** |
| plugin→host HTTP self-call | research: **no supported way** for a server plugin to learn the server base URL; the documented service discovery targets the shared background service, `@opencode/client` imports inside plugins are not blessed, and every real-world V2 plugin uses in-process `ctx`. Do not hardcode a port. | **closed (use ctx domains)** |
| publishing (npm still ships the V1 `{id, server}` shape) | fork is dual-export; `bun run build` locally fails in `git submodule update --init` for `packages/shared-skills/upstreams/*`. **P6-C1** |

## 3. Execution order

Each item: implement -> unit tests -> live verification on the isolated host **and** the real
service -> evidence under `.omo/evidence/20260923-v2-alignment/` -> commit.

1. **P5-A1** `model.request` headers/baseURL (closes Copilot initiator).
2. **P5-A2** `aisdk` options (generation params + variant). Probe first: dump `options` for a real
   request to learn the exact keys before writing the mapping.
3. **P5-A3** `permission.hook("evaluate")` -> re-enable omo's `skill` tool and any ask-gated path.
4. **P5-A5** `compaction.autocontinue`.
5. **P5-A4** shell guards.
6. **P5-A7** connected providers via `integration.connection`.
7. **P6-B2/B3/B4** task store, monitor, team runtime (largest; team last). All three are rewrites on
   V2-native domains rather than ports: `ctx.session.create/prompt/context` for member sessions,
   `ctx.worktree`/`ctx.vcs` for git orchestration, `ctx.storage` for the task/mailbox state
   (`ctx.generate.text` is also available for judge/summarize steps).
8. **P6-B1** session index for `session_list/search/info` (storage-backed; indexes sessions observed
   from load time, no backfill), and a TUI companion if exact/backfilled enumeration is required.
8. **P6-C1** build/publish path.
9. **P5-A6** `tool.definition` (verify feasibility, else record as unportable).

## 4. Verification requirements (hardening after the tool-turn bug)

The tool-turn bug (`fdcfe56`) escaped because verification stopped at "tool registered / command
delivered". Every future item must therefore also verify:

- **a full tool-call round**: prompt -> tool call -> tool result -> second model request succeeds;
- **the hook actually fired**, observed host-side (log/event), not assumed;
- **no regression in the 15 pre-existing failures** and no new ones.

`.omo/tmp/` is the only scratch location; nothing may be written outside the repository.
