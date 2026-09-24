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
| `chat.headers` (Copilot `x-initiator`) | **DONE**: `session.hook("model.request")` (official mapping) runs the unchanged V1 handler; the prompt `messageID` is remembered from the `prompt` hook because V2 puts no message on `model.request`, and the shim's `session.message` resolves it. Auxiliary kinds are skipped. End-to-end verified with a local HTTP sink: primary requests carry `x-initiator: agent` exactly when the internal marker is present. Copilot-only, so no runtime effect on this machine. | **P5-A1 done** |
| `chat.params` scalars | `ctx.session.hook("context")` -> `event.options` (official mapping) | **done for the keys**: V1 `maxOutputTokens` was written verbatim and V2 only knows `maxTokens`, so the max-output clamp silently did nothing; the bridge now maps keys both ways and seeds the V1 view from live V2 options. Live probe shows `options.maxTokens`/`temperature` reaching the provider body. |
| `chat.params` agent variant | applied at **agent registration** (`resolveModelVariant` -> agent `model.variant`), which all of this machine's models support via declared variants | done |
| `chat.params` `reasoningEffort` fallback (models with no declared variants) | no V2 home yet: V1 wrote it onto the mutable `input.message`, which V2 does not have | **open (small)** |
| `permission` (V1 `ctx.ask`) | `permission.hook("evaluate")` + `permission.list/get/reply`. **No consumer today**: both `ask` sites are optional and the only bash-ask tool (`monitor_*`) is unported. Use it when an ask-gated tool lands (P6-B3). | **P5-A3 assessed: no change** |
| shell guards (`interactive_bash`, bash read guard) | `shell.hook("create.before")` exists, but **omo never had a `shell.env` hook**: `non-interactive-env` is driven by `tool.execute.before`, already registered. | **P5-A4 assessed: not applicable** |
| `experimental.compaction.autocontinue` | **DONE for the omo-owned half**: `session.compaction.ended` (V2 has these events) drives `compactionContextInjector.restore` + `compactionTodoPreserver.restore` with V1's duplicate guard. The host question (`output.enabled`) has no V2 home, and V2 was measured NOT to resume an idle compacted turn; injecting a continuation prompt is deliberately skipped until mid-turn compaction is measured. | **P5-A5 done (mid-turn question open)** |
| `tool.definition` (todo description override) | **no target**: omo's only `tool.definition` hook rewrites the host `todowrite` description, and V2 ships no todo tool at all (binary grep: `todowrite` 0 hits vs `skill` 111 / `glob` 703). | **P5-A6 assessed: not applicable** |
| `command.execute.before` (auto-slash-command interception) | none needed: commands are now real V2 commands; the V1 interception only existed because V1 could not register commands | **closed** |

### Tools

| V1 tool | mechanism | status |
|---|---|---|
| `grep`, `glob`, `look_at`, `interactive_bash`, `background_output/cancel`, `call_omo_agent`, `task`, `skill_mcp` | registered (V1 bodies + client shim) | done |
| `session_read` | shim `session.messages` via `ctx.session.context` | done (`0892185`) |
| `session_list` / `session_search` / `session_info` | **DONE for path A** (index in `ctx.storage`, fed by the `prompt` hook and the event stream; live-verified across restarts, 13/1 registration). No server-plugin enumeration exists in ANY version. Web research (source-verified): `@opencode/plugin` 2.0.11 and 2.0.15 are byte-identical in `dist/promise/session.d.ts`, `ctx.session` still excludes `list`, three PRs proposing it are open/closed-unmerged (#46690 open), and `ctx.rpc` is not a generic host proxy (`rpc.call` is not attached; only `rpc.register`). **Two viable paths**: (A) omo keeps its own session index in `ctx.storage` (probe-verified: storage persists across restarts; `session.*` events carry `sessionID`), fed by `ctx.event.subscribe` + `session.hook("prompt")`; (B) ship a **TUI companion plugin**, whose shipped context DOES expose `context.data.session.list()` and `context.client` (full client) in 2.0.11. | **A now, B for exact/backfill** |
| `skill` | the V2 host's own `skill` tool loads omo-registered skills (live-verified), and every omo `ask` site is optional (`ctx?.ask`), so nothing is blocked. Registering omo's would add a duplicate namespaced tool that bypasses the host's permission flow; the two real deltas (slash-command execution, `definition.agent` restriction) are recorded instead. | **P5-A3 assessed: no change** |
| `task_create` / `task_update` | V2 removed host todos. Re-implement the per-session task store on `ctx.storage` and keep the tool contract; `todo-sync` becomes a no-op. | **P6-B2 (rewrite)** |
| `monitor_*` | monitor spawns commands; `ctx.shell` only has a hook, so the manager needs its own process spawning (Node/Bun) + output ring. Harness-neutral parts live in the repo already. | **P6-B3 (rewrite)** |
| `team_*` (12) | runtime primitives are harness-neutral (`packages/team-core`); the missing link is "spawn member session + send prompt + read result", and **`ctx.session.create/prompt/context` all exist**. Worktree orchestration can use `ctx.worktree`, git probes `ctx.vcs`. | **P6-B4 (rewrite, largest)** |

### Other

| item | status |
|---|---|
| provider / connected-providers filtering | **re-assessed with a live probe: stays unimplemented.** `integration.connections` / `connection.active` describe OAuth integrations, not usable providers: on this machine the catalogue has 225 integrations with **0 connections**, `connection.active("opencode")` is `"none"` while that provider works, and `provider.list()` lists only 1 provider (the config-declared deepseek/litellm/new-api are absent). A derived `connected` set would be empty (no change, still fail-open) or, on an OAuth host, would wrongly exclude usable providers. See `p5-a7-provider-connections-assessment.md`. | **P5-A7 assessed: no change** |
| `chat.headers` (Copilot initiator) | **`session.hook("model.request")` is mutable and carries `kind` + `agent` + `model.variant`** (live probe `live-v2-hook-surface.jsonl`). Auxiliary requests (`kind: "title"`) must be skipped. | **P5-A1 confirmed portable** |
| generation options via `aisdk` | the `aisdk.hook("sdk"/"language")` options are NOT the documented home for `chat.params` (the official mapping table sends `chat.params` to the `context` hook), and they **did not fire** in the probe for an `aisdk:@ai-sdk/openai-compatible` provider. Treat `aisdk` as a provider-SDK extension point, not the params path. | **closed** |
| plugin→host HTTP self-call | research: **no supported way** for a server plugin to learn the server base URL; the documented service discovery targets the shared background service, `@opencode/client` imports inside plugins are not blessed, and every real-world V2 plugin uses in-process `ctx`. Do not hardcode a port. | **closed (use ctx domains)** |
| publishing (npm still ships the V1 `{id, server}` shape) | fork is dual-export; `bun run build` locally fails in `git submodule update --init` for `packages/shared-skills/upstreams/*`. **P6-C1** |

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
7. **P6-B2/B3/B4** task store, monitor, team runtime (largest; team last). All three are rewrites on
   V2-native domains rather than ports: `ctx.session.create/prompt/context` for member sessions,
   `ctx.worktree`/`ctx.vcs` for git orchestration, `ctx.storage` for the task/mailbox state
   (`ctx.generate.text` is also available for judge/summarize steps).
8. **P6-B1** session index for `session_list/search/info` (storage-backed; indexes sessions observed
   from load time, no backfill), and a TUI companion if exact/backfilled enumeration is required.
8. **P6-C1** build/publish path.
9. **P5-A6** `tool.definition` — assessed, no target tool on V2 (the description belongs to the
   re-implemented task tool if P6-B2 lands).

## 4. Verification requirements (hardening after the tool-turn bug)

The tool-turn bug (`fdcfe56`) escaped because verification stopped at "tool registered / command
delivered". Every future item must therefore also verify:

- **a full tool-call round**: prompt -> tool call -> tool result -> second model request succeeds;
- **the hook actually fired**, observed host-side (log/event), not assumed;
- **no regression in the 15 pre-existing failures** and no new ones.

`.omo/tmp/` is the only scratch location; nothing may be written outside the repository.
