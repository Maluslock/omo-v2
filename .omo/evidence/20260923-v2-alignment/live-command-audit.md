# QA evidence — V2 slash-command port (`ctx.command.transform`)

Date: 2026-09-23
Host: opencode 2.0.11, private XDG-isolated `opencode serve` with the omo dist loaded from this repo
Plugin under test: `/home/user/omo-v2/dist/index.js`

## What was tested

Three changes, all of which the command port depends on:

1. `src/v2/command-mapping.ts` + `src/v2/register-commands.ts` + `src/v2/command-delivery.ts`
   — the port itself, wired into `createV2Plugin().setup`.
2. `src/v2/client-shim.ts` — a `tui.showToast` no-op (see "Two defects found" below).
3. `src/config/schema/commands.ts` — `handoff` added to `BuiltinCommandNameSchema`.

Claim under test: **on V2 a user can invoke omo's built-in slash commands, and each one delivers
its expanded template into the session (with the right agent) or is correctly refused.**

## Harness

`.omo/evidence/20260923-v2-alignment/command-qa.sh` (re-runnable; `bash command-qa.sh <port>`):

- creates a throwaway project with `[opencode].disabled_commands = ["hyperplan", "handoff"]`,
- starts `opencode serve` with its own `XDG_{DATA,CONFIG,STATE,CACHE}_HOME` and a known
  `OPENCODE_SERVER_PASSWORD`, omo loaded from the local dist,
- invokes each command through the real API — `POST /api/session/{id}/command {name, text}` — with a
  **fresh session per command** so one failed model turn cannot mask the next command's delivery,
- reads back the delivered user message from `GET /api/session/{id}/message`,
- asserts per command: HTTP status, that a non-trivial user message arrived, that no `$ARGUMENTS` /
  `$SESSION_ID` / `$TIMESTAMP` placeholder survived, and that command-specific markers appear.

`opencode run "/command args"` cannot be used for this: the CLI does not resolve slash commands, it
sends them to the model as plain text (verified). The session command API is the real surface.

## What was observed

```
invoke goal              http=204  delivered len=1277  tail "<user-task>\nQA-OBJECTIVE\n</user-task>"
invoke stop-continuation http=204  delivered len=599
invoke refactor          http=204  delivered len=18831 tail "<user-request>\nQA-TARGET\n</user-request>"
invoke remove-ai-slops   http=204  delivered len=6483
invoke handoff           http=404  (disabled in config)
invoke hyperplan         http=404  (disabled in config)
invoke nonexistent-command http=404
start-work               http=204  agent_before=build agent_after="Atlas - Plan Executor"
                         delivered len=7497, contains the session id and "QA-PLAN"

[v2] commands registered {"registered":5,"names":["goal","refactor","start-work","stop-continuation","remove-ai-slops"]}
no command execution failures
--- summary: pass=22 fail=0 ---
```

Raw artifact: `live-command-audit.log`. `live-command-audit-preceding-run.log` is the same harness
before the two fixes, kept because it shows the failures the fixes removed.

## Two defects found by this QA (both fixed)

### 1. Every command 500'd: the client shim had no `tui`

```
level=ERROR message="command execution failed" command=goal
error="TypeError: undefined is not an object (evaluating 'tui2.showToast')"
```

`plugin/chat-message.ts` calls `notifyWhenModelCacheIsMissing(pluginContext.client.tui)`, which does
`tui.showToast(...)`. The shim deliberately omitted `tui`, so reading `.showToast` off `undefined`
threw **synchronously**, escaping the caller's `.catch()` and aborting the whole hook chain. The
shim now exposes a logged no-op `tui.showToast` (V2 has no TUI domain for plugins), and
`client-shim.test.ts` pins that it resolves instead of throwing.

### 2. `disabled_commands` was silently ignored whenever it listed `handoff`

`BuiltinCommandNameSchema` had drifted from `features/builtin-commands/types.ts`: it was missing
`handoff`. Measured directly:

```
"disabled_commands": ["hyperplan"]           -> ["hyperplan"]      (honoured)
"disabled_commands": ["handoff"]             -> []                 (DROPPED)
"disabled_commands": ["goal", "handoff"]     -> []                 (whole array DROPPED)
```

So a user who listed `handoff` got **nothing** disabled — the whole array failed validation and was
replaced by the empty default. Fixed by adding `handoff` to the enum, with
`config/schema/commands.test.ts` asserting the enum equals the shipped command set so the two lists
cannot drift again. `assets/omo.schema.json` and `assets/oh-my-opencode.schema.json` were regenerated.

This is a V1 defect too, not something the port introduced.

### 3. `/start-work` silently delivered nothing: agent id mismatch

Command definitions name agents by config key (`atlas`), but V2 registers omo's agents under display
ids. Measured from inside a command (`ctx.agent.list({})`):

```
{"id": "Atlas - Plan Executor", "mode": "primary"}
{"id": "Sisyphus - ultraworker", "mode": "primary"}
{"id": "Prometheus - Plan Builder", "mode": "primary"}
```

`ctx.session.switchAgent({agent: "atlas"})` is accepted (the session then reads `agent: "atlas"`),
but the session runner fails afterwards and drops the prompt while the API still answers 204:

```
level=ERROR message="Failed to drain Session"
cause="Session.AgentNotFoundError: Agent not found: \"atlas\""
```

Delivery now resolves the declared name through the existing
`resolveRegisteredAgentName` (`atlas` -> `Atlas - Plan Executor`) and logs a warning when the name was
never registered, so this class of mismatch is no longer both silent and fatal.

## Why it is enough

The assertions run against the real HTTP surface of a real opencode 2.0.11 server with the real
plugin bundle, and the delivered text is read back from the session store rather than trusted from
the plugin's own return value. The negative controls (two disabled commands plus an unknown name all
404) prove the positive cases are not passing because "everything is accepted".

## What was omitted / not proven

- The assistant turn after each command fails in this harness (`provider.internal` — the isolated
  server has no provider credentials); only the user-message delivery is asserted, which is what the
  port is responsible for.
- Modest coverage of `delivery` values: every invocation here arrives as `steer`. The `queue` path is
  covered by unit tests (`command-delivery.test.ts`) but not live.
- No TUI smoke: the V2 TUI command palette is a different surface, and this environment is headless.
- The isolated server reads the real user layer (`~/.omo/omo.jsonc`) as well as the project layer;
  the project layer is what the harness varies.
