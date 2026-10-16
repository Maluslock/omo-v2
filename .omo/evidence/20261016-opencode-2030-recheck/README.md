# omo V2 adapter re-verified on `opencode` 2.0.30

**Date:** 2026-10-16 | **Host:** `opencode` 2.0.30 (upgraded in place from 2.0.11) | **Repo:** omo-v2 @ `master`

The port was developed and proven against `opencode` 2.0.11. The published line has since moved to
2.0.30, so this directory re-runs the §8 probe table of `docs/reference/v2-port-summary.md` against the
new host and records what changed underneath us.

## Result against the §8 probe table

| # | Probe | Status on 2.0.30 | How it was checked |
|---|---|---|---|
| 1 | one prompt with a tool call, `--format json` | **PASS** | `recheck-host.sh` |
| 2 | a plugin subscribing to `ctx.event.subscribe` | **PASS** | `event-catalog-2030.sh` |
| 3 | a plugin that sets `event.options` and reads the outgoing body | **PASS** | `gen-options-2030.sh` |
| 4 | a subagent that calls one tool then keeps working | **PARTIAL** | probes 1 and 2 |
| 5 | a turn that overflows the context limit | **PASS** | `compaction-2030.sh` |
| 6 | `tui.json`/`cli.json` plus a tmux TUI | **PASS** | `tui-slot-2030.sh` |

### Probe 1 - registration surface and a full tool round

`RUN_RC=0`, `ERROR_LINES=0`, `ISO=ISO_OK`, tool call `omo_glob` present, turn closed with `SMOKE_OK 2`.
Every registration count is identical to the 2.0.11 baseline: agents 12 (default `Sisyphus - ultraworker`),
tools 13 (1 skipped: `skill`), hooks 12, MCPs 5, commands 16, skills 20 (10 builtin, 17 from disk,
0 disabled, 0 unreadable). `[v2] session index ready` fired, so the storage-backed session backfill still
works. The plugin reads the new host version: `directory-agents-injector auto-disabled due to native
OpenCode support {"currentVersion":"2.0.30","nativeVersion":"1.1.37"}`.

### Probe 2 - event vocabulary

27 event types observed in one turn. The decisive ones still arrive:

- `session.execution.started` / `session.execution.succeeded` are delivered, so
  `packages/omo-opencode/src/v2/hook-mapping.ts:36`
  (`"session.execution.succeeded": "session.idle"`) is still live and every idle-driven hook
  (team and subagent liveness, todo continuation, notifications) keeps working.
- `session.idle` and `session.status` are still **not** emitted, so the translation layer is still
  required rather than merely nice to have.
- The definition layer is unchanged: `@opencode/schema` 2.0.30 carries the same 51 `session.*` names as
  2.0.15, including `session.created`, `session.execution.*` and `session.compaction.ended`, and still
  omits `session.idle`, `session.status`, `session.compacted` and `session.error`.

### Probe 6 - the TUI path

The TUI renders under tmux and the plugin loads in that path too: a 21-line plugin log delta carrying the
same registration sweep, plus a functional trace unique to the TUI side - the sidebar mirror heartbeat
writes its snapshot to `$XDG_DATA_HOME/opencode/storage/oh-my-openagent/tui-state` with the
`activeAgents`/`jobBoard`/`loop`/`projectDir`/`updatedAt`/`version` shape. The footer reports host `2.0.30`
and no failed plugin. `ISO=ISO_OK`.

### Probe 3 - generation fields reach the outgoing body

`gen-options-2030.sh` drives a fake OpenAI-compatible provider (`mock-provider.py`) and a context-hook
plugin that sets `temperature: 0.37`, `topP: 0.21`, `maxTokens: 1234`, `topK: 7`,
`reasoningEffort: "low"` and an unknown key `omoProbeSentinel` on `event.options`. Raw capture in
`out/probe3-gen-options.txt`, `RUN_RC=0`, `ISO=ISO_OK`:

| Set on `event.options` | Seen in the outgoing request |
|---|---|
| `temperature: 0.37` | `temperature=0.37` (same name) |
| `topP: 0.21` | `top_p=0.21` |
| `maxTokens: 1234` | `max_completion_tokens=1234` |
| `reasoningEffort: "low"` | `reasoning_effort="low"` |
| `topK: 7` | **dropped** |
| `omoProbeSentinel` (unknown) | **dropped** |

So the host does forward `event.options` to the wire - the contract
`packages/omo-opencode/src/v2/model-request-hook-mapping.ts` relies on - while the openai-compatible
package renames the keys and discards `topK`. The title request (no `tools`) carries no generation
fields at all. Common body keys: `store:false`, `stream:true`, `stream_options:{include_usage:true}`.

### Probe 5 - context overflow, compaction and resume

`compaction-2030.sh` reports 100000 prompt tokens against a model declaring `limit.context=4000` with
`settings.compaction={type:"summary"}` and runs two turns of the same standalone session. Raw capture in
`out/probe5-compaction.txt`: both turns exit 0 with their assistant text, `ISO=ISO_OK`, and the event
stream (55 events) carries `session.compaction.started`, `session.compaction.delta` and
`session.compaction.ended` with no `session.compaction.failed`. `session.compacted` is never emitted -
it exists in the schema only.

Two host details the probe documents:

- The summary is validated against a fixed template (`## Objective`, `## Requirements`, `## Decisions`,
  `## Work State` with `### Completed`/`### Active`/`### Blocked`, `## Next Move`, `## Relevant Files`,
  `## Important Context`). A provider reply that does not match fails the turn with
  `compaction.failed: Compaction summary did not match the required template`.
- There are two summary requests, not one: the first summary, then a second "update the existing
  checkpoint into one consolidated summary" pass. Five provider requests in total (title, summary,
  post-compaction turn, checkpoint consolidation, post-consolidation turn).

The same run also proves the mechanism `packages/omo-opencode/src/v2/compaction-hook-mapping.ts` uses.
A probe plugin registers `ctx.session.hook("compaction", ...)` exactly like `applyV1Compacting` and
appends a text part to `event.system`: the hook is called twice (once per compaction) with
`systemIsArray=true`, `messagesIsArray=true`, `optionsIsRecord=true`, `result` absent, and the sentinel
text is present in **both** summary request bodies (`SENTINEL_REQUESTS=2`). Appending to `event.system`
at compaction time therefore still reaches the summary request on 2.0.30. `LOG_V2_LINES=0` in this
capture is expected: the standalone probe loads only the probe plugins, not the port itself.

### Probe 4 - the part that is still only partial

The idle mapping's inputs are proven present (probe 2) and a tool round trip works (probe 1), but a
genuinely long-lived subagent was not driven to completion against 2.0.30.

## What changed under the port on 2.0.30

1. **The HTTP API moved under `/api/`.** `GET,POST /api/session`,
   `DELETE,GET,PATCH /api/session/{sessionID}`,
   `POST /api/session/{sessionID}/prompt`, plus new `/compact`, `/fork`, `/generate`, `/interrupt`,
   `/move`, `/wait`, `/shell`, `/synthetic`, `/view`, `/form`, `/agent`, `/model`, `/background`,
   `/command`, `/context`, `/diff`, `/inbox`, `/permission`, `/revert*`, `/environment` and
   `/experimental/*`. The old `POST /session` answers 405 and `GET /session` returns the SPA shell. The
   prompt body also changed shape: `{"text": "..."}` is required, while the V1
   `{"parts":[{"type":"text","text":"..."}]}` shape now returns
   `400 {"_tag":"InvalidRequestError","message":"Missing key\n  at [\"text\"]","kind":"Payload"}`, and
   `prompt_async` is gone. **Impact on this port: none.** `packages/omo-opencode/src/v2/client-shim.ts`
   and the rest of `packages/omo-opencode/src/v2/*.ts` contain no HTTP path literals and no
   `fetch`/`baseUrl`; every call goes through a `ctx.*` domain.
2. **`session.created` is delivered, but only once the subscription is live.** On 2.0.30 a session created
   before the plugin's first activity is not observed by the plugin. `session-created-ordering-2030.sh`
   creates and prompts session A, then creates and prompts session B: `CREATED_SAW_A=no`,
   `CREATED_SAW_B=yes`, `SUCCEEDED_SAW_A=yes`, `SUCCEEDED_SAW_B=yes`. The raw wire does carry it
   (`raw-event-stream-2030.sh`: `WIRE_HAS_SESSION_CREATED=yes`), and the plugin pipeline is byte-identical
   between the two hosts, so this is ordering rather than a dropped event. Practical impact: only the
   first session after a host start can miss the create-time work of the six `session.created`-keyed V1
   hooks (`packages/omo-opencode/src/hooks/runtime-fallback/event-handler.ts:283`,
   `hooks/auto-update-checker/hook.ts:82`, `hooks/legacy-plugin-toast/hook.ts:22`,
   `hooks/session-notification.ts:101`, `hooks/ast-grep-sg-provision/hook.ts:63`, and the codegraph
   bootstrap recorded in `packages/omo-opencode/src/hooks/AGENTS.md:34-36`).
3. **The project shim must default-export.** `export { default } from "<repo>/dist/index.js"` loads;
   `export * from ...` fails the server-side loader with
   `PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function. (cause: SchemaError(Missing key at ["default"]))`.
4. **The TUI boots through a managed background service on a fixed default port.** A leftover
   `opencode serve --service` from the previous install holds that port, and the sandboxed TUI then fails
   with `Managed service port 49374 on 127.0.0.1 is already in use by another process`. The probe gives
   the sandbox its own port with `opencode service set port <free>`.
5. **API type delta is additive only.** `SessionDomain` gains `remove` and `compact`; the tool context
   gains `signal: AbortSignal`; `ctx` gains a `credential` domain (`CredentialApi.activate`); the
   integration domain gains external methods and connection-status reporting; the TUI context gains
   dialog-select and rewritten keymap `layer` semantics; `permission`, `runtime` and `runtime-modules`
   are new modules. Nothing the port uses was removed or renamed.

## Environment changes made for this re-check

- **The host was upgraded in place** from 2.0.11 to 2.0.30 in the user's local install, with
  `package.json.bak-2.0.11` and `package-lock.json.bak-2.0.11` kept beside it for rollback.
- **The stale managed service was restarted.** `opencode serve --service` had been running the 2.0.11
  binary in memory since 2026-09-21 (PID 573362, port 49374). `opencode service restart` replaced it with
  PID 1291721 running the on-disk 2.0.30 binary, and `/home/user/.local/state/opencode/service.json` now
  reports `version = 2.0.30`.
- **The real database schema moved with it.** The restart ran three migrations
  (`20260923013825_project_time_active`, `20261007190000_azure_cli_external_credential`,
  `20261010180456_project_time_archived`), so rolling back is no longer just swapping the binary back -
  the database has to be restored as well.
- That managed service authenticates every route. `GET /openapi.json` returns 401 unless it is called
  with `Authorization: Basic base64("opencode:<password from service.json>")`; neither a bearer token nor
  `x-opencode-password` is accepted.
- Each probe still runs against its own isolated `XDG_*` tree and prints `ISO=ISO_OK` only after proving
  the real session database was not touched.

## Reproduce

```bash
export PATH="$PWD/.omo/tmp/qa-bin:$HOME/.bun/bin:$PATH"   # qa-bin/opencode -> the 2.0.30 binary
bash .omo/evidence/20261016-opencode-2030-recheck/recheck-host.sh
bash .omo/evidence/20261016-opencode-2030-recheck/event-catalog-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/serve-event-catalog-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/raw-event-stream-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/session-created-ordering-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/gen-options-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/compaction-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/tui-slot-2030.sh
```

Each script runs against an isolated `XDG_*` tree and prints `ISO=ISO_OK` only after proving the real
session database was not touched.
