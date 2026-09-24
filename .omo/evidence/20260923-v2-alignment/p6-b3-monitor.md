# P6-B3: monitor tools ported to V2 (2026-09-24)

## Why

`monitor_start` / `monitor_stop` / `monitor_list` / `monitor_output` were the four tools blocked only
by the client surface, not by a missing V2 primitive: the manager spawns processes itself and pushes
output through the shared prompt gate, which already dispatches into the V2 client shim. The one real
gap was `ctx.ask`: V2 has no interactive permission prompt, so the monitor's bash gate hard-denied
every command (`[ERROR] monitor_start denied: ask() is not available in this host; refusing to
auto-approve`). Monitor documents `monitor.allowed_commands` as the fallback when the host exposes no
bash permission gate, so the fix is to make the ask site consult that allowlist.

## What changed

- `v2/ask-resolver.ts` (new, 51 LOC): `createV2AskResolver(pluginConfig)` returns the V1 `ask` shape.
  - `permission === "bash"` and the command's first token is in `monitor.allowed_commands` -> resolves.
  - anything else -> rejects with a message naming `monitor.allowed_commands`, i.e. fail closed rather
    than the previous silent-host failure.
  - `commandProgram()` reuses the monitor's own `tokenizeCommand` so allowlist matching cannot drift.
- `v2/register-tools.ts`: the four `monitor_*` names moved from `CLIENT_DEPENDENT_TOOLS` to
  `SHIM_UNLOCKED_TOOLS`; `toV2Tool` now receives `ask: askResolver` for every registered tool.
- `v2/register-tools.test.ts`: asserts the four monitors register and are no longer blocked.

## Unit verification

```
bun test packages/omo-opencode/src/v2/ask-resolver.test.ts
 7 pass, 0 fail
```

Covers: first-token extraction (incl. leading whitespace and empty command), allowlisted program
approved, non-allowlisted program rejected with the `monitor.allowed_commands` message, no allowlist
= everything denied, non-bash permission rejected.

## Live verification (isolated host, real omo dist bundle)

Sandbox: fresh `XDG_*` roots under `.omo/tmp/monitor-probe`, project dir `.omo/tmp/monitor-probe/proj`,
config enabling `monitor.enabled` with `allowed_commands: ["bash","sh","echo","sleep"]`. omo loaded
from the locally built `dist/index.js`. One `opencode run --standalone --format json` message asked the
model to start a 3-line monitor, read its output, then stop it. Raw transcript:
`.omo/tmp/monitor-probe/run2.json`.

```
omo_monitor_start  status=completed -> monitor_id: mon_3664dc99 | mode: idle | caps: max_monitors_per_session=3, max_runtime_ms=1800000
omo_monitor_output status=completed -> {"lines":[{"stream":"stdout","seq":1,"text":"MONITOR_LINE_1"},
                                                {"stream":"stdout","seq":2,"text":"MONITOR_LINE_2"},
                                                {"stream":"stdout","seq":3,"text":"MONITOR_LINE_3"}],
                                        "counters":{"totalLines":3,"matchedLines":3,...}}
omo_monitor_stop   status=completed -> {"status":"stopped","monitor_id":"mon_3664dc99"}
MONITOR_LINE 命中数: 3
```

The previous denial line is gone from the log window. The deferred output push also fired, i.e. the
automatic delivery path (not just the pull path) reaches the session through the prompt gate:

```
[prompt-async-gate] promptAsync dispatched {"sessionID":"ses_f2dcad078ffe1BkEEZogu3i8P1","source":"monitor-output:mon_3664dc99:batch-2"}
[monitor] Sent deferred monitor output: {"sessionID":"...","monitorId":"mon_3664dc99","batchSeq":2}
```

That is a full tool-call round: prompt -> `omo_monitor_start` -> result -> next model request ->
`omo_monitor_output` -> result -> `omo_monitor_stop` -> final text.

## Regression check

`bun test` (full suite) after the change: **12905 pass / 3 skip / 13 fail**. The 13 failures are the
pre-existing baseline set (auto-slash-command x4, auto-update-checker/checker x5 mock-isolation flake,
`command.execute.before` x1, DMCA provenance x1, install-codex/Codex version sync x2). Pass count is
baseline +7, matching the new ask-resolver tests exactly.

`tsgo --noEmit` exits 0.

## Why this is enough

- The unit tests pin the allowlist decision table (including the deny path), so a future refactor
  cannot silently re-widen the ask gate.
- The live probe drives the real bundle on a real host and covers all three monitor tools plus the
  unsolicited output delivery path, which is the part that touches shared session state.
- Fail-closed semantics are preserved for every other permission kind: the resolver rejects rather
  than approves when it does not recognize the request.

## What was omitted

- The transcript contains only synthetic `MONITOR_LINE_*` output; no secrets or user data.
- Monitor output is injected as an internal prompt, so the safety argument rests on the shared prompt
  gate. That gate is unchanged by this work; this diff only makes the four tools reachable.

## Residual risk

- `ask` is now passed to every registered tool, not only the monitors. Any other tool that asks for a
  non-bash permission now fails with a clear error instead of the previous opaque host failure. That
  is the intended fail-closed behaviour, but it is a behaviour change for tools whose ask sites were
  previously unreachable on V2 (none are known to call `ask` today).
- Monitor output arriving between turns depends on the prompt gate's post-dispatch hold; the live run
  showed batch-2 delivered, but a long monitor that outlives the session is not exercised here.
