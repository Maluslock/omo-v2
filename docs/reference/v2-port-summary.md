# omo on OpenCode V2 - alignment summary

**Generated:** 2026-09-24 | **Host:** `opencode` 2.0.11, re-verified on 2.0.30 (2026-10-16) | **Range:**
`213b501` (V2 plugin skeleton) to `9f450e2`, 81 commits

This is the outcome summary of porting the OpenCode Ultimate edition of oh-my-openagent onto the
OpenCode 2.x plugin API. The working plan and the per-capability mapping live in
`../superpowers/plans/2026-09-24-omo-v2-full-parity.md`; the developer guide for the adapter code
itself is [v2-plugin-adapter.md](v2-plugin-adapter.md).

## 1. Outcome

The plugin loads and runs on 2.0.11 with the real user configuration:

```
agents  12   (default: Sisyphus - ultraworker)
tools   13 registered / 1 skipped, plus +12 team, +4 monitor, +4 task, +3 goal when enabled
hooks   12 registrations fanning out to the full V1 tier composition
mcps    5     (lsp serves 8 LSP tools)
commands 16
skills  20
```

Every V1 capability has either a working V2 path or a measured reason why the host cannot support it,
and every shipped feature loads on 2.0.11, including the **TUI sidebar plugin**, which now exports both
host generations and renders into the 2.x `sidebar.content` slot.

## 2. Capability matrix

| V1 capability | V2 mechanism | State |
|---|---|---|
| Built-in MCPs | `ctx.mcp.transform` | ported |
| Slash commands | `ctx.command.transform` + plugin-side prompt delivery | ported |
| Skills | `ctx.skill.transform` (builtins and runtime sources only) | ported |
| Agents (model, variant, permissions) | `ctx.agent.transform` | ported |
| Tools (12 always on, +23 gated) | `ctx.tool.transform` + the V1 client shim | ported |
| `chat.message` | `session.hook("prompt")` | ported |
| `chat.params` (generation options, variant) | `session.hook("context")` | ported |
| `chat.headers` (Copilot initiator) | `session.hook("model.request")`, primary requests only | ported |
| `experimental.chat.messages.transform` | `session.hook("context").messages` | ported |
| `experimental.chat.system.transform` | `session.hook("context").system` | ported |
| `experimental.session.compacting` | `session.hook("compaction")` | ported |
| `compaction.autocontinue` | `session.compaction.ended` state restore | ported; continuation is host-native |
| `event` | `ctx.event.subscribe` + a corrected event vocabulary + `message.updated` synthesized from the V2 step events | ported |
| `tool.execute.before/after` | `ctx.tool.hook(...)` | ported |
| `permission` | fail-closed self-answer (`ask-resolver.ts`) | ported as far as the host allows |
| Session enumeration | omo's own index in `ctx.storage` + a read-only host-store backfill | ported |
| Task tools | plain JSON storage, per-location list id, async file lock | ported |
| Monitor tools | own process spawning + the prompt gate; `monitor.allowed_commands` for the bash ask | ported |
| Team tools (12) | background manager for members, the prompt gate for live delivery | ported |
| Goal tools | client-free registry tools | ported |
| TUI sidebar | `Plugin.define({id, setup})` on the `sidebar.content` slot, entry in `cli.json` `plugins` | ported |

## 3. Host behavior that contradicted the plan

Each of these changed the implementation, and each has a live probe behind it.

| Assumption | Measured reality |
|---|---|
| `session.idle` fires on turn end | V2 never emits it. The turn envelope is `session.execution.started` to `session.execution.succeeded`; mapping that is what makes idle-keyed hooks fire at all. |
| `session.status` can be stubbed as empty | An empty map means "every session is gone" to the background manager, which stops live subagents after about 9 seconds. The status map has to be rebuilt from the turn envelope. |
| Unknown `context.options` keys pass through as provider options | The surface is typed. V1 names must be translated (`maxOutputTokens` to `maxTokens`); arbitrary keys are dropped. |
| `reasoningEffort` has no V2 channel | Typed camelCase `reasoningEffort` is honored and lowered to the provider's `reasoning_effort`. The earlier "no channel" reading came from testing the snake spelling. |
| A V1 `chat.params` handler runs once bridged | It returns early without a `message` record, so the whole chain was dead. The bridge synthesizes it from `event.model.variant`. |
| Session enumeration needs a TUI companion plugin | It only works while a TUI is open. Reading the host's `session_v2` store read-only works headless and covers sessions created before omo loaded. |
| Team tools need a rewrite around `ctx.session`/`ctx.worktree` | Ten of twelve factories ignore `client`, and both real uses were already V2-native. The block was a stale denylist entry. |
| Connected-provider filtering should narrow model choice | `integration.connections` describes OAuth integrations, not usable providers (0 connections while providers work). Filtering stays off. |

## 4. Bugs found and fixed

V2 port bugs:

- Finished tool calls were projected as `running`, so the tool-pair validator injected a placeholder
  into a user message and the provider rejected the whole request (`fdcfe56`).
- `maxOutputTokens` was written verbatim into typed options, so the max-output clamp did nothing
  (`25ed701`).
- The `chat.params` chain never ran at all because the bridge omitted the required `message` record
  (`63e4052`). This silently dropped per-session generation params for every subagent.
- Team members were aborted mid-turn because `session.status` was an empty stub (`5b3e790`).
- Every idle-keyed hook was dead because `session.idle` has no V2 counterpart (`5b3e790`).
- `client.tui.showToast` was missing, so every command route returned HTTP 500 (`1492a33`).
- Every hook keyed on `message.updated` - preemptive compaction, runtime fallback, the todo enforcer,
  session notifications, the Anthropic recovery hook, about twenty call sites in all - was **dormant on
  V2**, because `message.updated` exists only in the schema's V1 namespace and nothing synthesized it.
  V2's `session.step.started` (provider, model, agent, dispatch time) and `session.step.ended` (finish,
  tokens, cost) now rebuild it through a stateful mapper, so the event reaches the V1 handlers with the
  fields they read.
- `session.summarize` had no V2 target: the shim never exposed `ctx.session.compact`, so every call threw
  a `TypeError` that the V1 call sites swallow. It is now mapped, and it rejects (rather than returning
  `{error}`) because no call site inspects `response.error`.
- `session.create` dropped `parentID`, so subagent sessions were created unlinked from their parent.
- Tools were handed a fabricated `AbortController().signal` nothing could abort; they now get the host's
  own `context.signal`, so a user interrupt reaches a running tool.

Pre-existing bugs found while probing (not V2-specific):

- `disabled_commands: ["handoff"]` silently disabled nothing, because one unknown enum member made
  Zod drop the whole array (`cdc822a`).
- A category's documented `max_tokens` was never read; only the deprecated `maxTokens` was (`bc769b6`).
- `task_create` failed under parallel writes because the file lock was not awaited (`b519eca`).
- The `task-reminder` hook had tests but was never composed into any tier (`8610b10`).

## 5. Verification method

Every capability follows the same ladder, and the evidence files record each rung:

1. **Unit tests** co-located with the mapping or module, written to fail first when a defect exists.
   The V2 adapter carries 30 test files.
2. **Isolated live probes** on a copied real config, a sandbox XDG tree, the locally built
   `dist/index.js`, and a real provider, asserting on a full tool-call round rather than on
   registration.
3. **Observable host artifacts** where the tool result is not the proof: the plugin log window
   (`sessionStatus: "busy"`, `team member idled`, `compaction ended: omo state restored`), the
   sandbox SQLite session rows, and the outgoing provider body via an `http.request` probe.
4. **Before/after pairs** for behavior changes, built from the pre-change commit so the claim is tied
   to the diff rather than to a hypothesis.
5. **Full suite** compared against the known baseline of 13 pre-existing failures.

Current state (2026-10-16, after the `message.updated` synthesis): `bun test` reports 12971 pass /
3 skip / **13 fail - the same 13 pre-existing failures** (Codex installer version sync, the DMCA
attribution pins, two command-dispatch cases and the six network-dependent auto-update checks),
none of them in `src/v2/`; `tsgo --noEmit` exits 0.
The V2 subset alone - `bun test packages/omo-opencode/src/v2/` - is 282 pass / 0 fail after the
`message.updated` synthesis (2026-10-16).

## 6. Commit map

| Area | Commits |
|---|---|
| V2 skeleton, event/hook bridges, tool registration | `213b501` through `bce6fcd` (P0 to P3) |
| MCPs, commands, skills | `3d86321`, `f7cf7d4`, `cdc822a`, `0155f4c`, `1492a33` |
| Tool-turn projection, session read | `fdcfe56`, `0892185` |
| Generation options, compaction restore | `25ed701`, `484f2aa` |
| Assessments with no change (permission, shell, tool.definition, providers) | `4addc44`, `9559e10`, `63c5e9e`, `4ed45ea`, `c418a8e` |
| chat.headers, local build recipe | `bdbd6ef`, `dc6df74` |
| Task tools, task-reminder | `b519eca`, `8610b10` |
| Monitor tools and the ask resolver | `7f78e4e` |
| Team tools, background liveness, idle mapping | `5b3e790` |
| chat.params chain, real-config smoke, mid-turn compaction | `63e4052`, `c69077e`, `c2c3c24` |
| Category `max_tokens`, config docs | `bc769b6`, `48cee04` |
| Session enumeration backfill | `ca7fa33` |
| `reasoningEffort` resolution, TUI shape finding | `9f450e2` |
| 2.0.30 re-verification, and the parity gaps it exposed | `2201e6348`, `f73a145d5` (probe table), `73b18b061` (client shim), `c77056cc6` (`message.updated` synthesis) |

## 7. Open items

| Item | Detail |
|---|---|
| TUI sidebar plugin | **Closed** (`2d5ef10`): both blockers recorded here before the port are resolved. The client-config target now resolves per host generation (`cli.json` + `plugins` for 2.x, `tui.json` + `plugin` for 1.x), and `dist/tui.js` exports both host generations, with the 2.x path claiming `sidebar.content` and publishing through `context.storage.memory`. Evidence: `p6-b12-tui-plugin-port.md`. |
| Session titles in tool output | `session_list` and `session_info` do not print a session title. Pre-existing formatter behavior, unrelated to V2. |
| `reasoningEffort` for unknown model families | Dropped on purpose by omo's shared capability guard, identically on V1. |
| V1 `message.part.updated` | Still unmapped: V2 streams parts as `session.text.*` / `session.reasoning.*`, and the three V1 consumers (`runtime-fallback/first-prompt-watchdog.ts`, `session-notification.ts`, `ralph-loop/event-handler-activity.ts`) sleep on V2. Only assistant steps are synthesized today. |
| npm publishing | Not done in this fork. The published package still exports the V1 `{id, server}` shape and is rejected by 2.0.11; shipping the V2 adapter goes through the release workflow. |

## 8. How to re-verify

The unit gate is cheap; the live gate is what catches host-behavior drift.

```bash
bun test                 # 13 pre-existing failures are the baseline
npx tsgo --noEmit
OMO_SKIP_MATERIALIZE=1 bun run build
```

For one capability on a live host: build, write a project `plugins/omo-local.ts` that re-exports
`dist/index.js`, run `opencode run --standalone` against an isolated `XDG_*` tree with a copied
config, and assert on the tool result plus the log window. The adapter guide documents the recipe and
the gotchas; the per-capability proof is in the evidence files below.

Re-run these probes when the host version changes:

| Probe | Watches for |
|---|---|
| one prompt with a tool call, `--format json` | registration counts and a full tool-call round |
| a plugin that subscribes to `ctx.event.subscribe` | the event vocabulary (a missing `session.idle` breaks every idle hook) |
| a plugin that sets `event.options` and reads the outgoing body | which generation fields the host forwards and under which names |
| a subagent or team member that calls one tool then keeps working | whether the host still reports it as busy |
| a turn that overflows the context limit | compaction events and whether the turn resumes |
| `tui.json`/`cli.json` plus a tmux TUI | which client config the host reads and whether the CLI plugin loads |

Last re-run: `opencode` **2.0.30** (2026-10-16). All six probes pass; probe 4 was the one that had only
been inferred from probe 2, and it now has its own script.

- Probes 1 (registration plus one tool round), 2 (event vocabulary) and 6 (TUI slot and sidebar mirror)
  reproduce the 2.0.11 results. `session.execution.started`/`succeeded` still arrive, so the `session.idle`
  translation stays load-bearing; `session.idle` and `session.status` are still never emitted.
- Probe 3 saw `temperature` forwarded as-is and `topP`/`maxTokens`/`reasoningEffort` renamed to
  `top_p`/`max_completion_tokens`/`reasoning_effort` on the wire, with `topK` and unknown keys dropped.
- Probe 5 saw overflow trigger a summary compaction, all three `session.compaction.*` events fire, the
  turn resume, and the compaction hook's `event.system` addition reach the summary request - the channel
  `compaction-hook-mapping.ts` writes to. Pointing the mock at an off-template summary produced
  `session.compaction.failed` and failed the turn, which is what a bad summary does to a live session.
- Probe 4: a second session with `parentID` set, prompted while the provider held its reply for 12s,
  still reached the plugin bus as `session.execution.started` then `session.execution.succeeded` keyed by
  its own id (the parent session saw no events at all). Replaying that capture through
  `packages/omo-opencode/src/v2/session-activity.ts` yields `{child: busy}` mid-turn and `{}` afterwards,
  so the map that stops the background manager from treating a live subagent as gone rebuilds correctly
  on 2.0.30. No model was asked to *choose* to delegate; the probe drives the child session directly.
- One delivery boundary did move: `session.created` only reaches plugins after the plugin's first prompt,
  so every session created before that window is missed (`WINDOW=pre_first_prompt_window`). The raw wire
  still carries the event, so this is subscription ordering rather than a dropped name.

The write-up, the observed API changes (`/api` route prefix, the `{"text"}` prompt body), the in-place
host upgrade plus the managed-service restart and its three database migrations, and the residual risk
list are in `../../.omo/evidence/20261016-opencode-2030-recheck/README.md`.

## 9. Evidence index

All under `../../.omo/evidence/20260923-v2-alignment/` (force-added because `.omo/*` is ignored).

| File | Covers |
|---|---|
| `research/REPORT.md`, `research/opencode-v2-plugin-host-api-research.md` | Source-verified host API surface, extracted type packages |
| `live-v2-hook-surface.md`, `live-v2-storage-events.md` | Which domains and hooks exist, storage persistence |
| `live-v2-event-catalog.md` | Full event vocabulary for one turn; the missing `session.idle` |
| `live-generation-options.md`, `p6-b6-chat-params-bridge.md`, `p6-b10-reasoning-effort-channel.md` | Generation options, the dead `chat.params` gate, the effort channel |
| `p5-a3-permission-assessment.md`, `p5-a4-shell-assessment.md`, `p5-a6-tool-definition-assessment.md`, `p5-a7-provider-connections-assessment.md` | The four "no change" assessments |
| `live-session-read.md`, `live-session-index.md` | Session reading and the storage-backed index |
| `p6-b2-task-tools.md`, `p6-b2b-task-reminder.md` | Task tools and the reminder hook |
| `p6-b3-monitor.md` | Monitor tools end to end |
| `p6-b4-team.md`, `p6-b5-background-liveness-and-idle-mapping.md` | Team tools, subagent liveness, event vocabulary |
| `p6-b7-mid-turn-compaction.md` | Three compactions inside one turn, the turn continues |
| `p6-b8-category-max-tokens.md` | The ignored `max_tokens` key |
| `p6-b9-session-backfill.md` | Enumeration backfill from the host store |
| `p6-b11-tui-plugin-v1-shape.md` | The TUI module shape failure |
| `p6-b12-tui-plugin-port.md` | The TUI sidebar port: dual-generation export, `sidebar.content`, and the client-config target |
| `p6-real-config-smoke.md`, `p6-c1-local-build.md` | Real-config smoke and the supported build recipe |

The client-shim parity fixes and the `message.updated` synthesis were verified live in a third
directory, `../../.omo/evidence/20261016-v2-shim-parity-gaps/` (force-added): `README.md` (the four
verdicts and what they do *not* prove), `run-shim-parity-probe.sh`, the probe plugin
`zz-shim-parity-probe.ts` (it imports the production `v2/client-shim.ts`, `v2/tool-mapping.ts` and
`v2/event-subscription.ts` and is driven by a real tool call), `mock-provider.py`, and the captures
under `out/` (`probe7-*` for the three shim fixes, `probe8-*` for the synthesis).

The 2.0.30 re-verification lives in its own directory,
`../../.omo/evidence/20261016-opencode-2030-recheck/` (also force-added): `README.md`; the probe scripts
(`recheck-host.sh`, `event-catalog-2030.sh`, `serve-event-catalog-2030.sh`, `raw-event-stream-2030.sh`,
`session-created-ordering-2030.sh`, `subagent-liveness-2030.sh`, `gen-options-2030.sh`,
`compaction-2030.sh`, `tui-slot-2030.sh`); the replay helper `session-activity-replay.ts` that feeds a
capture through the real `v2/session-activity.ts` tracker; the static `schema-diff-2030.sh` and the
read-only `real-db-readonly-2030.sh`, which runs the plugin's backfill query shape against the migrated
real database; the event probe plugin `event-catalog-probe-2030.ts`; the fake provider
`mock-provider.py`; `run-recheck-all.sh`, which runs the probes in the four groups the shared plugin log
forces and then the two static checks, and sweeps the sandboxes its own run created; and every raw
capture under `out/`.
