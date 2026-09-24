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
| `event` **vocabulary** | **DONE after a full-catalog live capture**: V2 never emits `session.idle`, `session.status` or `session.compacted` - the turn envelope is `session.execution.started` -> `session.execution.succeeded`, and compaction ends with `session.compaction.ended`. `hook-mapping.ts` now maps those onto the V1 names, which is what makes every idle-keyed hook fire (it was the reason team member status never left `running` and live delivery never triggered). `failed`/`interrupted` are deliberately not mapped to idle. | **P6-B5 done** |
| `chat.headers` (Copilot `x-initiator`) | **DONE**: `session.hook("model.request")` (official mapping) runs the unchanged V1 handler; the prompt `messageID` is remembered from the `prompt` hook because V2 puts no message on `model.request`, and the shim's `session.message` resolves it. Auxiliary kinds are skipped. End-to-end verified with a local HTTP sink: primary requests carry `x-initiator: agent` exactly when the internal marker is present. Copilot-only, so no runtime effect on this machine. | **P5-A1 done** |
| `chat.params` scalars | `ctx.session.hook("context")` -> `event.options` (official mapping) | **DONE, after finding the chain was dead**: V1 `maxOutputTokens` was written verbatim (V2 only knows `maxTokens`), *and* the bridge omitted the `message` record `buildChatParamsInput` requires, so the handler returned `null` for every request - no per-session prompt params (stored on every subagent launch), no clamp, no variant lowering, for any agent. The bridge now synthesizes the message from `event.model.variant` and writes a lowered variant back. Live before/after on the provider body: `temperature`/`top_p` from a category were absent in all 7 requests before and present on the member's request after. |
| `chat.params` `reasoningEffort` fallback (models with no declared variants) | **host limitation, measured**: `context.options` is a closed typed surface - a probe setting `reasoning_effort`, `thinking`, `verbosity`, `top_k` and a custom key produced a body carrying only `max_tokens`/`top_p`/`temperature` and dropped the rest (an earlier "unknown keys pass through" claim was a false positive from system-prompt text). V2's answer to reasoning levels is declared `model.variant`, which the bridge now applies at request time too (`event.model.variant` written in `context` is honored by the primary request). The V1 fallback stays inert on models that declare no variants. | **open (no V2 channel)** |
| `permission` (V1 `ctx.ask`) | `permission.hook("evaluate")` decides requests the **host** created; it cannot create one, and V2 `ToolContext` has no `ask`. So the plugin must answer the ask itself: `v2/ask-resolver.ts` approves bash commands whose program is in `monitor.allowed_commands` and rejects everything else (fail closed, with a message naming the config key). That is exactly the fallback monitor documents for a host without a bash gate. | **P6-B3 done (fail-closed resolver)** |
| shell guards (`interactive_bash`, bash read guard) | `shell.hook("create.before")` exists, but **omo never had a `shell.env` hook**: `non-interactive-env` is driven by `tool.execute.before`, already registered. | **P5-A4 assessed: not applicable** |
| `experimental.compaction.autocontinue` | **DONE and the host half is unnecessary**: `session.compaction.ended` drives `compactionContextInjector.restore` + `compactionTodoPreserver.restore` with V1's duplicate guard. A live mid-turn measurement (context limit forced to 70k, 6 large `read` calls in one turn) shows the host runs **three** compactions inside a single turn and continues after each one, finishing with the correct final answer - so injecting a continuation prompt would duplicate work. The idle case (compacting an idle session) does not resume, which is the host's design; the enforcer's compaction guard is armed on every compaction, which is what suppresses a spurious continuation. | **P5-A5 + P6-B7 done** |
| `tool.definition` (todo description override) | **no target**: omo's only `tool.definition` hook rewrites the host `todowrite` description, and V2 ships no todo tool at all (binary grep: `todowrite` 0 hits vs `skill` 111 / `glob` 703). | **P5-A6 assessed: not applicable** |
| `command.execute.before` (auto-slash-command interception) | none needed: commands are now real V2 commands; the V1 interception only existed because V1 could not register commands | **closed** |

### Tools

| V1 tool | mechanism | status |
|---|---|---|
| `grep`, `glob`, `look_at`, `interactive_bash`, `background_output/cancel`, `call_omo_agent`, `task`, `skill_mcp` | registered (V1 bodies + client shim) | done |
| `session_read` | shim `session.messages` via `ctx.session.context` | done (`0892185`) |
| `session_list` / `session_search` / `session_info` | **DONE for path A** (index in `ctx.storage`, fed by the `prompt` hook and the event stream; live-verified across restarts, 13/1 registration). No server-plugin enumeration exists in ANY version. Web research (source-verified): `@opencode/plugin` 2.0.11 and 2.0.15 are byte-identical in `dist/promise/session.d.ts`, `ctx.session` still excludes `list`, three PRs proposing it are open/closed-unmerged (#46690 open), and `ctx.rpc` is not a generic host proxy (`rpc.call` is not attached; only `rpc.register`). **Two viable paths**: (A) omo keeps its own session index in `ctx.storage` (probe-verified: storage persists across restarts; `session.*` events carry `sessionID`), fed by `ctx.event.subscribe` + `session.hook("prompt")`; (B) ship a **TUI companion plugin**, whose shipped context DOES expose `context.data.session.list()` and `context.client` (full client) in 2.0.11. | **A now, B for exact/backfill** |
| `skill` | the V2 host's own `skill` tool loads omo-registered skills (live-verified), and every omo `ask` site is optional (`ctx?.ask`), so nothing is blocked. Registering omo's would add a duplicate namespaced tool that bypasses the host's permission flow; the two real deltas (slash-command execution, `definition.agent` restriction) are recorded instead. | **P5-A3 assessed: no change** |
| `task_create` / `task_get` / `task_list` / `task_update` | **DONE**: they only needed unblocking - storage is plain JSON files and `todo-sync` is fail-soft (the shim's empty todo stub plus an unresolvable `opencode/session/todo`). Two live-probe fixes came with it: the task list id now follows `ctx.location.directory` (one V2 server serves many projects) and `acquireLockAsync` waits for the file lock so parallel task writes stop failing. Off by default (`experimental.task_system ?? false`). Also wired the long-dead `task-reminder` hook (it had tests but was referenced nowhere) so the model is nudged after 10 non-task tool calls; `task-reminder` is now in `HookNameSchema`. | **P6-B2 done** |
| `monitor_*` | **DONE**: no rewrite was needed - the manager spawns its own processes and injects output through the shared prompt gate, which already targets the V2 shim. The only blocker was `ctx.ask`; `v2/ask-resolver.ts` now answers it from `monitor.allowed_commands`. Live-proved on the isolated host: `monitor_start` (id `mon_3664dc99`) -> `monitor_output` returned all 3 `MONITOR_LINE_*` lines -> `monitor_stop`, plus the deferred delivery path (`source: "monitor-output:mon_3664dc99:batch-2"`). Off by default (`monitor.enabled`); needs an explicit `allowed_commands` when enabled. | **P6-B3 done** |
| `team_*` (12) | **DONE - and the block was never real.** Ten of the twelve factories take `client` and immediately `void client`; the two real uses are V2-native (`team_create` -> background manager, served by the shim; `team_send_message` live delivery -> shared prompt gate). tmux layout is a no-op unless `tmux_visualization` is on, and worktrees are plain git. Live-proved end to end: create (real member session `ses_f2db52673ffe...` spawned and prompted), status, message with live delivery, task CRUD, delete; the member replied `PROBE_WORKER_OK` and received an injected `<peer_message>`. The probe is what exposed the two V2 gaps below. | **P6-B4 done** |
| background subagent liveness (`client.session.status`) | **DONE**: V2 has no status domain, so the shim used to return an empty map - which the manager reads as "every session is gone" and stops a live subagent after ~9s (observed: a team member aborted mid-turn while `sessionStatus` was unresolvable). `v2/session-activity.ts` rebuilds the map from the turn envelope plus per-step/delta heartbeats, reports only busy sessions, and bounds itself with a 90s staleness TTL and a 500-entry cap. Rerun shows `"sessionStatus":"busy"` holding the task open until the member's turn actually ends. | **P6-B5 done** |

### Other

| item | status |
|---|---|
| provider / connected-providers filtering | **re-assessed with a live probe: stays unimplemented.** `integration.connections` / `connection.active` describe OAuth integrations, not usable providers: on this machine the catalogue has 225 integrations with **0 connections**, `connection.active("opencode")` is `"none"` while that provider works, and `provider.list()` lists only 1 provider (the config-declared deepseek/litellm/new-api are absent). A derived `connected` set would be empty (no change, still fail-open) or, on an OAuth host, would wrongly exclude usable providers. See `p5-a7-provider-connections-assessment.md`. | **P5-A7 assessed: no change** |
| `chat.headers` (Copilot initiator) | **`session.hook("model.request")` is mutable and carries `kind` + `agent` + `model.variant`** (live probe `live-v2-hook-surface.jsonl`). Auxiliary requests (`kind: "title"`) must be skipped. | **P5-A1 confirmed portable** |
| generation options via `aisdk` | the `aisdk.hook("sdk"/"language")` options are NOT the documented home for `chat.params` (the official mapping table sends `chat.params` to the `context` hook), and they **did not fire** in the probe for an `aisdk:@ai-sdk/openai-compatible` provider. Treat `aisdk` as a provider-SDK extension point, not the params path. | **closed** |
| plugin→host HTTP self-call | research: **no supported way** for a server plugin to learn the server base URL; the documented service discovery targets the shared background service, `@opencode/client` imports inside plugins are not blessed, and every real-world V2 plugin uses in-process `ctx`. Do not hardcode a port. | **closed (use ctx domains)** |
| category `max_tokens` was ignored (found by the P6-B6 probe) | **FIXED**: `tools/delegate-task/delegated-model-config.ts` `applyCategoryParams` read only the deprecated `config.maxTokens`, while `CategoryConfigSchema` documents `max_tokens` - so a user's `max_tokens` never reached the delegated model on V1 or V2. It now reads the documented key first and falls back to the alias, matching the `reasoning`/`reasoningEffort` precedence already in that object literal. Live before/after on the provider body: the member request went from `max_tokens=None` to `max_tokens=4321`. | **P6-B8 done (pre-existing bug, not V2-specific)** |
| publishing (npm still ships the V1 `{id, server}` shape) | fork is dual-export. Local build fixed: the submodule failure is repository state (`.gitmodules` declares them, the index has no gitlinks), and the repo already ships `OMO_SKIP_MATERIALIZE=1`, so `OMO_SKIP_MATERIALIZE=1 bun run build` completes and its artifact is live-verified. Actual npm publishing still goes through the release workflow (not run). | **P6-C1 local path done; publish not done** |

## 3. Execution order

Each item: implement -> unit tests -> live verification on the isolated host **and** the real
service -> evidence under `.omo/evidence/20260923-v2-alignment/` -> commit.

1. **P5-A1** `model.request` headers/baseURL (closes Copilot initiator).
2. **P5-A2** `aisdk` options (generation params + variant). Probe first: dump `options` for a real
   request to learn the exact keys before writing the mapping.
3. **P5-A3** `permission` — assessed, no change needed (see the evidence note); the hook is the
   mechanism to use when an ask-gated tool is ported, and omo's `skill` tool stays unregistered in
   favour of the host's.
4. **P5-A5** `compaction.autocontinue` — done for the state restore; the mid-turn continuation
   question needs a measurement before any prompt injection is added.
5. **P5-A4** shell guards — assessed, nothing to port (omo's env work rides `tool.execute.before`).
6. **P5-A7** connected providers — assessed with live data, stays unimplemented (the integration
   connection API is not a usability signal, and the fail-open fallback already yields the right set).
7. **P6-B2** task tools, **P6-B3** monitor, **P6-B4** team runtime and **P6-B5/B6** the three gaps
   those probes exposed (background liveness, the V1 idle mapping, the dead `chat.params` chain) - all
   done. The remaining V2-native work is `ctx.generate.text` for judge/summarize steps,
   `ctx.worktree`/`ctx.vcs` for non-team git orchestration, and `ctx.storage` for anything currently
   file-backed.
9. **P6-B1** session index for `session_list/search/info` (storage-backed; indexes sessions observed
   from load time, no backfill), and a TUI companion if exact/backfilled enumeration is required.
10. **P6-C1** build/publish path - local build resolved and verified; publishing itself untouched.
11. **P5-A6** `tool.definition` — assessed, no target tool on V2 (the description belongs to the
    re-implemented task tool now that P6-B2 landed).

## 4. Verification requirements (hardening after the tool-turn bug)

The tool-turn bug (`fdcfe56`) escaped because verification stopped at "tool registered / command
delivered". Every future item must therefore also verify:

- **a full tool-call round**: prompt -> tool call -> tool result -> second model request succeeds;
- **the hook actually fired**, observed host-side (log/event), not assumed;
- **no regression in the 15 pre-existing failures** and no new ones.

`.omo/tmp/` is the only scratch location; nothing may be written outside the repository.
