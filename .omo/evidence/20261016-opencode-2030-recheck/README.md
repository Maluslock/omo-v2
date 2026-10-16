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
| 3 | a plugin that sets `event.options` and reads the outgoing body | **NOT RE-RUN** (static check only) | plugin dist diff |
| 4 | a subagent that calls one tool then keeps working | **PARTIAL** | probes 1 and 2 |
| 5 | a turn that overflows the context limit | **NOT RE-RUN** | - |
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

## Not re-run, and why

- **Probe #3 (which generation fields the host forwards).** Only the static side was checked: the
  `@opencode/plugin` dist diff between 2.0.11 and 2.0.30 shows no change on the option path, and the
  generation-field names in the client and protocol packages were not removed. The live
  outgoing-body probe still needs a fake provider to capture the request; it was not rebuilt here.
- **Probe #4 (long-running subagent liveness).** Partially covered: the events the idle mapping consumes
  are proven present (probe 2). A run with a genuinely long-lived subagent was not repeated.
- **Probe #5 (context overflow and resume).** Not re-run; it needs a scenario that overflows the real
  context window.
- **The stale managed service in the real environment** still runs the 2.0.11 binary in memory
  (PID 573362, port 49374). Restarting it so the user's own TUI talks to a 2.0.30 server was left as a
  decision rather than done quietly.

## Reproduce

```bash
export PATH="$PWD/.omo/tmp/qa-bin:$HOME/.bun/bin:$PATH"   # qa-bin/opencode -> the 2.0.30 binary
bash .omo/evidence/20261016-opencode-2030-recheck/recheck-host.sh
bash .omo/evidence/20261016-opencode-2030-recheck/event-catalog-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/serve-event-catalog-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/raw-event-stream-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/session-created-ordering-2030.sh
bash .omo/evidence/20261016-opencode-2030-recheck/tui-slot-2030.sh
```

Each script runs against an isolated `XDG_*` tree and prints `ISO=ISO_OK` only after proving the real
session database was not touched.
