# omo V2 adapter re-verified on `opencode` 2.0.30

**Date:** 2026-10-16 | **Host:** `opencode` 2.0.30 (upgraded in place from 2.0.11) | **Repo:** omo-v2 @ `master`

The port was developed and proven against `opencode` 2.0.11. The published line has since moved to
2.0.30, so this directory re-runs the §8 probe table of `docs/reference/v2-port-summary.md` against the
new host and records what changed underneath us.

## Build fingerprint

The claims below are about a specific build, so they are pinned to one:

| What | Value |
|---|---|
| `git rev-parse HEAD` when the captures were taken | `f73a145d589394b5ef17ed09bf52876fa381cc27` |
| last commit touching `packages/omo-opencode/src` | `618bdd41f fix(tui): record the cause of a failed sidebar mirror flush` |
| `dist/index.js` sha256 | `3ce0b3a32a4964a5ced40613abef41e1a29f64485eb8c80981519991719e6199` |
| `dist/index.js` size / mtime | `5837616` bytes / `2026-09-30 10:53:14` |

**No port code was changed for 2.0.30.** The 2.0.30 work in this directory is probe scripts and
documentation; the only non-probe source change in the same change set is a fix to the QA harness itself
(see "Two harness defects found while doing this" below).

## How to read this directory

One command produces every capture:

```bash
bash .omo/evidence/20261016-opencode-2030-recheck/run-recheck-all.sh
```

It writes `out/*.txt` and appends a timestamped line per step to
`.omo/tmp/run-recheck-all.progress`. Probe 1 (omo itself) and probe 6 (TUI + omo) each measure a line
delta on the shared plugin log `/tmp/oh-my-opencode.log`, so the orchestrator runs them alone, after the
probe-plugin-only runs have finished.

The scripts **only print**; there is no assertion layer. A verdict in the table below is a human reading
of the committed capture against the stated expectation, and the capture is committed next to it so the
reading can be checked. `event-catalog-probe-2030.ts` is the subscribing plugin the event probes load.

## Result against the §8 probe table

| # | Probe | Status on 2.0.30 | Capture |
|---|---|---|---|
| 1 | one prompt with a tool call, `--format json` | **PASS** | `out/probe1-recheck-host.txt` |
| 2 | a plugin subscribing to `ctx.event.subscribe` | **PASS** | `out/probe2-event-catalog.txt` |
| 3 | a plugin that sets `event.options` and reads the outgoing body | **PASS** | `out/probe3-gen-options.txt` |
| 4 | a subagent that calls one tool then keeps working | **PASS** (two evidence chains) | `out/probe4-ordering.txt`, `out/probe4b-subagent-liveness.txt` |
| 5 | a turn that overflows the context limit | **PASS** (including the failure branch) | `out/probe5-compaction.txt`, `out/probe5b-compaction-failed.txt` |
| 6 | `tui.json`/`cli.json` plus a tmux TUI | **PASS** | `out/probe6-tui-slot.txt` |

Supporting captures: `out/schema-diff.txt` (definition layer), `out/real-db-readonly.txt` (the
plugin's own query shape against the migrated real database), `out/qa-lib-db-path.txt` and
`out/qa-lib-cleanup.txt` (the two QA-harness fixes described below).

### Probe 1 - registration surface and a full tool round

`RUN_RC=0`, `ERROR_LINES=0`, `LOG_DELTA=25`, `[v2] session index ready` fired
(`SESSION_INDEX_READY=1`), tool call `omo_glob` present, turn closed with `SMOKE_OK 2`,
`ISO_BEFORE=ISO_AFTER=297`. Every registration count is identical to the 2.0.11 baseline: agents 12
(default `Sisyphus - ultraworker`), tools 13 (1 skipped: `skill`), hooks 12, MCPs 5, commands 16, skills
20. The plugin reads the new host version: `directory-agents-injector auto-disabled due to native
OpenCode support {"currentVersion":"2.0.30","nativeVersion":"1.1.37"}`.

Two footnotes this capture settles:

- **skills 20 is not 10 + 17.** `packages/omo-opencode/src/v2/register-skills.ts:111` merges with
  `dedupeV2SkillsById([...builtins, ...fromDisk])`, so the log line reports the de-duplicated union
  (`registered:20`) next to the two source counts (`builtin:10`, `fromDisk:17`); 7 names exist in both.
- **`directory-agents-injector`**. It disables itself when the host has native agent support, because the
  host then already injects `AGENTS.md`/agent files. With a native-capable host there is no double
  injection from this hook; the `nativeVersion` string it prints (`1.1.37`) is the plugin's own gate
  value, not the host version.

### Probe 2 - event vocabulary

`OBSERVED_TOTAL` is in the mid-20s for one turn - 23 in the committed capture, 27 in an earlier run; the
count moves with prompt timing while the decisive names do not. `PROBE_ERRORS=none`,
`ISO_BEFORE=ISO_AFTER=297`. What matters:

- `session.execution.started` / `session.execution.succeeded` are delivered, so
  `packages/omo-opencode/src/v2/hook-mapping.ts:36`
  (`"session.execution.succeeded": "session.idle"`) is still live. What that proves is the *trigger*; the
  consumers of the status it feeds are covered by probe 4's replay, not here.
- `session.idle` and `session.status` are still **not** emitted, so the translation layer is still
  required rather than merely nice to have.
- `session.created` is **absent** from the plugin bus in this topology - see "What changed" item 2 for the
  ordering boundary and `out/probe4-ordering.txt` for the evidence.

### Probe 3 - generation fields reach the outgoing body

`gen-options-2030.sh` drives a fake OpenAI-compatible provider (`mock-provider.py`) and a context-hook
plugin that sets `temperature: 0.37`, `topP: 0.21`, `maxTokens: 1234`, `topK: 7`,
`reasoningEffort: "low"` and an unknown key `omoProbeSentinel` on `event.options`. The capture prints both
field presence *and* the wire values, per request (`RUN_RC=0`, `BODY_COUNT=2`,
`PROVIDER_REQUESTS=2`, `ISO=ISO_OK`):

| Set on `event.options` | Seen in the outgoing request (capture line) |
|---|---|
| `temperature: 0.37` | `temperature=0.37` (same name) |
| `topP: 0.21` | `WIRE_top_p=0.21 from_topP` |
| `maxTokens: 1234` | `WIRE_max_completion_tokens=1234 from_maxTokens` |
| `reasoningEffort: "low"` | `WIRE_reasoning_effort="low" from_reasoningEffort` |
| `topK: 7` | **dropped** (`FIELD_topK=ABSENT`, no wire key) |
| `omoProbeSentinel` (unknown) | **dropped** (`FIELD_omoProbeSentinel=ABSENT`) |

So the host does forward `event.options` to the wire - the contract
`packages/omo-opencode/src/v2/model-request-hook-mapping.ts` relies on - while the openai-compatible
package renames the keys and discards `topK`. `REQ_0 has_tools=False` is the title request (no generation
fields, no `tools`); `REQ_1 has_tools=True` carries them all. Common body keys: `store:false`,
`stream:true`, `stream_options:{include_usage:true}`.

### Probe 4 - subagent liveness, two ways

This probe is the one the first pass got wrong, so it is now two independent captures.

**4a - when `session.created` is observable** (`out/probe4-ordering.txt`). Three sessions: A and B are
created *before* the plugin's first prompt, C after it.

```text
CREATED_SAW_A=no  CREATED_SAW_B=no  CREATED_SAW_C=yes
SUCCEEDED_SAW_A=yes SUCCEEDED_SAW_B=yes SUCCEEDED_SAW_C=yes
WINDOW=pre_first_prompt_window
```

So the boundary is **"sessions created before the plugin's first prompt are not observed"**, not "only the
first session after a host start". That is the stronger and correct statement; the §8 text and
`docs/reference/v2-port-summary.md` were corrected accordingly.

**4b - a busy child session across the liveness window** (`out/probe4b-subagent-liveness.txt`). The probe
starts a sandboxed `opencode serve`, creates a parent session, then creates a child session with
`parentID` set and prompts **only the child**; the mock provider stalls 12 s (`DELAY_SECONDS=12`) so the
turn outlives the plugin's ~9 s "gone" window. At T+10 s the raw event dump is snapshotted, and the
capture is replayed through the **real** `createSessionActivityTracker`
(`packages/omo-opencode/src/v2/session-activity.ts`, driven by `session-activity-replay.ts`).

```text
CHILD_PARENT_FIELD=ses_ebc487436ffeA5Wk540R95ubNz        (host accepts parentID; matches the parent session)
PROMPT_HTTP=200   CHILD_SUCCEEDED_WITHIN_DEADLINE=yes
PARENT_EVENT_TYPES=none   OTHER_SESSION_IDS=none          (events are per-sessionID, not "latest session")
MIDTURN_EVENTS=4   MIDTURN_CHILD_STILL_WORKING=yes         (busy at T+10s, past the ~9s gone-window)
REPLAY_MIDTURN: REPLAY_EVENTS=4   REPLAY_STATUSES_AT_END=ses_ebc4873c5ffetiP3OtaNAeTUNt  busy_ever=yes cleared_by=none
REPLAY_FULL:    REPLAY_EVENTS=12  REPLAY_STATUSES_AT_END=none  cleared_by=session.execution.succeeded
ISO_BEFORE=ISO_AFTER=297
```

In words: while the child is still working its status survives the gone-window (so liveness is not a
false negative mid-turn), and once `session.execution.succeeded` arrives the status clears (so it is not a
stuck-positive either). What is still not exercised: the rest of the chain - what each idle-driven hook
does with that status - and a model-driven `delegate-task` call. The child session here is created by the
host API, exactly as the delegate path creates it, but no model ever chose to delegate.

### Probe 5 - context overflow, compaction and resume

`compaction-2030.sh` reports 100000 prompt tokens against a model declaring `limit.context=4000` with
`settings.compaction={type:"summary"}` and runs two turns of the same standalone session
(`out/probe5-compaction.txt`): both turns exit 0 with their assistant text, `ISO=ISO_OK`, and the 55-event
stream carries `session.compaction.started`, `session.compaction.delta` and `session.compaction.ended`
with `HAS_session_compaction_failed=no`. `session.compacted` is never emitted - it exists in the schema
only.

Two host details the probe documents:

- The summary is validated against a fixed template (`## Objective`, `## Requirements`, `## Decisions`,
  `## Work State` with `### Completed`/`### Active`/`### Blocked`, `## Next Move`, `## Relevant Files`,
  `## Important Context`).
- There are two summary requests, not one: the first summary, then a second "update the existing
  checkpoint into one consolidated summary" pass. `PROVIDER_REQUESTS=5` in total (title, summary,
  post-compaction turn, checkpoint consolidation, post-consolidation turn).

**5b - the failure branch, demonstrated rather than asserted** (`out/probe5b-compaction-failed.txt`).
`BAD_SUMMARY=1` makes the fake provider reply `This is not the required summary template.`; the same probe
then reports `HAS_session_compaction_failed=yes`, `HAS_session_compaction_ended=no`,
`TURN_ONE_RC=1`/`TURN_TWO_RC=1` (the bad template fails the turn), `COMPACTION_EVENT_TYPES=[delta,
failed, started]`, `SENTINEL_REQUESTS=4`. In the good run the same fields read `SENTINEL_REQUESTS=2`.

The same pair of runs proves the mechanism
`packages/omo-opencode/src/v2/compaction-hook-mapping.ts` uses. A probe plugin registers
`ctx.session.hook("compaction", ...)` exactly like `applyV1Compacting` and appends a text part to
`event.system`: the hook is called twice (once per compaction) with `systemIsArray=true`,
`messagesIsArray=true`, `optionsIsRecord=true`, `result` absent, and the sentinel text is present in
**both** summary request bodies. Appending to `event.system` at compaction time therefore still reaches
the summary request on 2.0.30. `LOG_V2_LINES=0` in these captures is expected: the standalone probes load
only the probe plugins, not the port itself.

### Probe 6 - the TUI path

`out/probe6-tui-slot.txt`: `PANEL_RENDERED=yes` under tmux, `PLUGIN_LOG_DELTA=21`, and the six
registration rows re-parsed out of the plugin log window
(`REG_AGENTS`/`REG_TOOLS`/`REG_HOOKS`/`REG_MCPS`/`REG_COMMANDS`/`REG_SKILLS`) - the same sweep as probe 1.
The sidebar mirror heartbeat writes `MIRROR_JSON_FILES=1` snapshot with
`MIRROR_KEYS=activeAgents,jobBoard,loop,projectDir,updatedAt,version` (`MIRROR_HAS_FIELDS=yes`, all six).
The footer reports host `2.0.30` and no failed plugin. `ISO_BEFORE=ISO_AFTER=297`.

One global-state hazard this probe now checks instead of assuming: the TUI path needs a managed service on
a free port, so the probe calls `opencode service set port`. That writes `{"port": N}` to the **sandbox's**
`$XDG_CONFIG_HOME/opencode/service.json` (the capture prints `SANDBOX_SERVICE_STATE`), and the probe
records the real `~/.local/state/opencode/service.json` before and after, reporting
`GLOBAL_SERVICE_UNTOUCHED=yes`. The leftover `opencode serve --service` from the old install is the hazard
being fenced off: it holds port 49374 and makes a sandboxed TUI fail with
`Managed service port 49374 on 127.0.0.1 is already in use by another process`.

## Two harness defects found while doing this

Both were found because this re-check tried to *prove* isolation rather than assert it, and both are
visible in the committed captures.

1. **`ISO=ISO_OK` was vacuous on 2.0.30.** The QA library's `oqa_db_path()` ran `opencode db path | head
   -1`. 2.0.30 removed the `db` subcommand, so the CLI printed its top-level help and the function
   returned the first line of that help: `DESCRIPTION`. `[ -f "$REALDB" ]` was then always false, the
   before/after count compared a value with itself, and every "the real database was not touched" line was
   empty of content. `out/qa-lib-db-path.txt` records the old output, the QA library's own self-check
   failing (`FAIL: oqa_db_path returned 'DESCRIPTION'`), and the fix.
2. **The fix:** `oqa_db_path()` in `.agents/skills/opencode-qa/scripts/lib/common.sh` now resolves through
   `opencode db path` (older hosts) → `opencode debug paths | awk '$1=="db"{print $2; exit}'` (2.0.30's
   spelling - `opencode debug paths` prints a `db` row) → probing
   `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`. Every candidate must exist as a file
   before it is returned. After the fix the library self-check is green and every capture in this
   directory prints a real `ISO_DB`/`ISO_BEFORE`/`ISO_AFTER` pair (`297` → `297` for the session table).

Two more harness defects surfaced the same way, and the QA library now handles both. `oqa_cleanup` calls
a new `oqa_kill_sandbox_processes`, which kills every process whose environment still points at a sandbox
before the sandbox is deleted. That matters because the TUI path bootstrapes a managed
`opencode serve --service` which **daemonizes** (ppid 1) with a sandbox-scoped `XDG_*` tree: the library's
`OQA_SERVER_PID` does not cover it, and a daemon left alive re-creates its (already deleted) XDG path on
the way out. Before the fix, one suite run left five `/tmp/oqa-xdg.*` directories behind and a stray
service process; after it, `out/qa-lib-cleanup.txt` shows the leaking probe (`tui-slot-2030.sh`) finishing
with `SANDBOXES_AFTER=0` and `SANDBOX_SCOPED_SERVICES_AFTER=0` (`CLEANUP=OK`) while the user's real
managed service is still the only `serve --service` process left. Related script-level fixes: scripts that
had cleared the library's `EXIT` trap leave it in place so `oqa_cleanup` runs (a `bash -x` run shows it
firing), and the `opencode serve` launches now `exec`, so `$!` is the server itself rather than a subshell -
the first pass orphaned ten servers on their ports. `run-recheck-all.sh` additionally sweeps the sandboxes
its own run created, as a belt-and-braces measure.

### Does the port still work on the database 2.0.30 migrated?

`out/real-db-readonly.txt` answers it without writing: it runs the plugin's own query shape
(`getSqliteMainSessions` in `packages/omo-opencode/src/tools/session-manager/sqlite-storage.ts` -
`select id, project_id, directory, title, parent_id, version, time_created, time_updated from session_v2
where (parent_id is null or parent_id = '') order by time_updated desc`) against the real database opened
`mode=ro`:

```text
REAL_DB=~/.local/share/opencode/opencode.db   SESSION_TABLE_ROWS=297   SESSION_V2_ROWS=380
BACKFILL_MAIN_ROWS=88   BACKFILL_CHILD_ROWS=292   BACKFILL_DROPPED_ROWS=0
MIGRATIONS_APPLIED=50
MIGRATIONS_NEWEST=20261010180456_project_time_archived,20261007190000_azure_cli_external_credential,20260923013825_project_time_active
```

`BACKFILL_DROPPED_ROWS=0` means every row the plugin's query returns still has every column it reads, so
the SQLite session backfill works on the migrated schema - and probe 1 independently shows the backfill
running end to end inside a fresh 2.0.30 sandbox (`[v2] session index ready`).

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
   `prompt_async` is gone. **Impact on this port: none.** The audit is a grep for HTTP surfaces over
   `packages/omo-opencode/src/v2/` **and** the shared prompt-dispatch helper
   `packages/omo-opencode/src/shared/prompt-async-gate.ts` (the surface that actually submits prompts and
   therefore the most exposed one): three hits, all of them comments. Every call goes through a `ctx.*`
   domain; nothing in-tree is an external HTTP client.
2. **`session.created` is delivered - but not to a session created before the plugin's first prompt.** On
   2.0.30, with sessions A and B created before the first prompt and C after it,
   `CREATED_SAW_A=no`, `CREATED_SAW_B=no`, `CREATED_SAW_C=yes` (`WINDOW=pre_first_prompt_window`; see
   probe 4a). The raw wire does carry it even for those sessions (`raw-event-stream-2030.sh`:
   `WIRE_HAS_SESSION_CREATED=yes`), and the plugin's event pipeline
   (`dist/promise/adapter.js`, the `Schema.encodeUnknownEffect(OpenCodeEvent)` subscription pipe) is
   byte-identical between 2.0.11 and 2.0.30 - so this is ordering/lazy start, not a dropped event.
   **Impact:** the create-time work of the six `session.created`-keyed V1 hooks is skipped for sessions
   that predate the plugin's first prompt (`packages/omo-opencode/src/hooks/runtime-fallback/event-handler.ts:283`,
   `hooks/auto-update-checker/hook.ts:82`, `hooks/legacy-plugin-toast/hook.ts:22`,
   `hooks/session-notification.ts:101`, `hooks/ast-grep-sg-provision/hook.ts:63`, and the codegraph
   bootstrap recorded in `packages/omo-opencode/src/hooks/AGENTS.md:34-36`). Each of those hooks is
   additionally driven by other events, so this is a first-interaction gap, not a dead hook - but it is
   broader than "only the first session after a host start" and is listed as an open item below.
3. **The project shim must default-export.** `export { default } from "<repo>/dist/index.js"` loads;
   `export * from ...` fails the server-side loader with
   `PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function. (cause: SchemaError(Missing key at ["default"]))`.
4. **The TUI boots through a managed background service on a fixed default port.** A leftover
   `opencode serve --service` from the previous install holds that port; see probe 6.
5. **API type delta is additive only.** `SessionDomain` gains `remove` and `compact`; the tool context
   gains `signal: AbortSignal`; `ctx` gains a `credential` domain (`CredentialApi.activate`); the
   integration domain gains external methods and connection-status reporting; the TUI context gains
   dialog-select and rewritten keymap `layer` semantics; `permission`, `runtime` and `runtime-modules`
   are new modules. Nothing the port uses was removed or renamed.
6. **The definition layer is unchanged.** `out/schema-diff.txt` compares `@opencode/schema` 2.0.15 (the
   baseline package captured under `../20260923-v2-alignment/research/pkgs/x_opencode_schema2.0.15/`) with
   2.0.30: `BASELINE_SESSION_EVENTS=51`, `NEW_SESSION_EVENTS=51`, `REMOVED_IN_NEW=none`,
   `ADDED_IN_NEW=none`, and the declarations of `session.created`,
   `session.execution.started` and `session.compaction.ended` are textually identical
   (`readonly type: Schema.Literal<"session.created">;` and friends). `session.idle`, `session.status`,
   `session.compacted` and `session.error` are still absent from both. This is why the probe table could
   move from 2.0.11 to 2.0.30 without a type-level port change.

## What this re-check does not prove

- **No model-driven delegation.** Probe 4b creates the child session through the host API, which is the
  shape the delegate path produces, but no model chose to delegate and `delegate-task` itself was not run.
- **Only the tracker, not every consumer.** Probe 4b replays through the real session-activity tracker;
  what each idle-driven hook does with that status is still covered by unit tests, not by this directory.
- **TTL expiry by unit test only.** The replay runs in milliseconds against the default `Date.now` clock,
  so the 90 s activity TTL is not exercised here.
- **Six `session.created` hooks not individually observed.** Their keys were located in source; probe 4a
  establishes the delivery boundary they sit behind.
- **The `/api` migration was audited statically** (grep plus reading the two dispatch surfaces). No
  in-tree external HTTP client exists to exercise, and the port's own paths do not use HTTP at all.
- **Compaction template details.** Probe 5b demonstrates the failure branch with a deliberately
  non-conforming summary; it does not enumerate every acceptance rule the host applies.

## Environment changes made for this re-check

- **The host was upgraded in place** from 2.0.11 to 2.0.30 in the user's local install, with
  `package.json.bak-2.0.11` and `package-lock.json.bak-2.0.11` kept beside it for rollback.
- **The stale managed service was restarted.** `opencode serve --service` had been running the 2.0.11
  binary in memory since 2026-09-21 (PID 573362, port 49374). `opencode service restart` replaced it with
  PID 1291721 running the on-disk 2.0.30 binary, and `~/.local/state/opencode/service.json` now reports
  `version = 2.0.30`.
- **The real database schema moved with it.** The restart ran three migrations
  (`20260923013825_project_time_active`, `20261007190000_azure_cli_external_credential`,
  `20261010180456_project_time_archived`; `MIGRATIONS_APPLIED=50` in total), so rolling back is no longer
  just swapping the binary back - the database has to be restored as well.
- That managed service authenticates every route. `GET /openapi.json` returns 401 unless it is called
  with `Authorization: Basic base64("opencode:<password from service.json>")`; neither a bearer token nor
  `x-opencode-password` is accepted.
- Each probe still runs against its own isolated `XDG_*` tree, and now prints `ISO=ISO_OK` only after a
  real before/after comparison of the session table in the real database.

## Reproduce

```bash
export PATH="$PWD/.omo/tmp/qa-bin:$HOME/.bun/bin:$PATH"   # qa-bin/opencode -> the 2.0.30 binary
bash .omo/evidence/20261016-opencode-2030-recheck/run-recheck-all.sh     # everything, in order
```

Individual scripts, if you want one at a time:

| Script | Writes |
|---|---|
| `recheck-host.sh` | `out/probe1-recheck-host.txt` |
| `event-catalog-2030.sh` | `out/probe2-event-catalog.txt` |
| `gen-options-2030.sh` | `out/probe3-gen-options.txt` |
| `session-created-ordering-2030.sh` | `out/probe4-ordering.txt` |
| `subagent-liveness-2030.sh` | `out/probe4b-subagent-liveness.txt` |
| `compaction-2030.sh` (`BAD_SUMMARY=1` for the failure branch) | `out/probe5-compaction.txt`, `out/probe5b-compaction-failed.txt` |
| `tui-slot-2030.sh` | `out/probe6-tui-slot.txt` |
| `serve-event-catalog-2030.sh` | `out/probe-serve-catalog.txt` |
| `raw-event-stream-2030.sh` | `out/probe-raw-wire.txt` |
| `schema-diff-2030.sh` (static) | `out/schema-diff.txt` |
| `real-db-readonly-2030.sh` (static, read-only) | `out/real-db-readonly.txt` |
| `verify-cleanup-2030.sh` (wraps the TUI probe) | `out/qa-lib-cleanup.txt` |

Helpers they share: `event-catalog-probe-2030.ts` (the subscribing probe plugin),
`mock-provider.py` (fake OpenAI-compatible provider, `--reply`/`--summary-file`/`--delay-seconds`),
`session-activity-replay.ts` (replays a capture through the real session-activity tracker),
`run-recheck-all.sh` (the orchestrator), `verify-cleanup-2030.sh` (proves the harness leaves nothing
behind).

## Open items carried out of this re-check

- The `session.created` window (item 2) - decide whether the six hooks need a compensating path for
  sessions created before the plugin's first prompt.
- `docs/reference/v2-port-summary.md:3` and `docs/reference/v2-plugin-adapter.md:3` now name the 2.0.30
  re-verification; any future probe additions should keep the `out/` captures in sync, since the table
  above is only as good as the capture beside it.
