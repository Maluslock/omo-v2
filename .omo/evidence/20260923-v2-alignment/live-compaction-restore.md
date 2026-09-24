# P5-A5 `compaction.autocontinue` — what V2 does and what was ported (evidence)

Date: 2026-09-24
Probe: isolated `XDG_*` (providers copied, no `plugins` list) plus a project plugin. Two phases:
an omo-free probe to learn V2's native behaviour, then the same flow with omo loaded.
Artifacts: `.omo/tmp/compaction-probe/` (scratch), raw event dump analysed below.

## V2's native behaviour after compaction

A seeded session (real assistant reply, 3 messages) was compacted through
`POST /api/session/{id}/compact`. Event order, straight from the plugin's `ctx.event.subscribe`:

```
session.execution.started ... session.step.started ... session.step.ended
session.execution.succeeded
session.inbox.delivered
session.compaction.started
session.compaction.delta x179
session.usage.updated
session.compaction.ended
session.execution.succeeded
```

Two findings:

1. **The compaction hooks and events exist and fire.** `session.compaction.started` / `.delta` /
   `.ended` are real, and `ctx.session.hook("compaction")` fired with
   `{agent, messages, model, options, sessionID, system, tools}`.
2. **V2 does NOT resume the turn after compaction.** The only event after
   `session.compaction.ended` is `session.execution.succeeded`; there is no new
   `session.execution.started`, no `session.step.started`, and no new assistant text. The message
   count went 3 -> 5, which is the summary/system traffic, not a continued agent turn.

Caveat: this is an **idle, API-triggered** compaction. A compaction that happens *while the agent
loop is running* (context window filling mid-step) was not tested, and the runner may well continue
there on its own.

## What V1 asked for, and what V2 can express

V1's `experimental.compaction.autocontinue` handler did two things at once:

```
if (isCompactionAgent(input.agent)) { output.enabled = false; return }
if (guardedSessions.has(input.sessionID)) { output.enabled = false; return }
markAutocontinueAllowed(input.sessionID)
await compactionContextInjector.restore(sessionID)
await compactionTodoPreserver.restore(sessionID)
```

- `output.enabled` is a question to the host ("resume the turn?"). V2 has no autocontinue hook and
  no output channel on `compaction`, so that half cannot be answered at all.
- The two `restore` calls only touch omo's own state. Those are portable, and they are what the port
  implements, triggered by `session.compaction.ended`.

## What was implemented

`src/v2/compaction-end-restore.ts` + wiring in `register-hook-assembly.ts`:

- subscribes to the raw event stream, and on `session.compaction.ended` runs
  `compactionContextInjector.restore` then `compactionTodoPreserver.restore`, isolating each step so
  a failure cannot abort the other (V1's `runCompactionStep` behaviour);
- keeps V1's duplicate guard (5s per session, `unref`-ed timer) because V2 can emit the end event
  more than once;
- bounds `dispose()` (2s) so a stream that ignores the abort signal cannot hold teardown open,
  mirroring `startV2EventSubscription`;
- **does not inject a continuation prompt.** Injecting one where V2 already continues mid-turn is
  exactly the duplicate-injection hazard the shared prompt gate exists to prevent, and the mid-turn
  case is untested. Continuation stays with omo's existing session-tier hooks, which the event
  stream already drives.

## Observed with omo loaded

```
[v2] session index ready {"entries":1,"directory":".../compaction-probe/proj"}
[v2] compaction ended: omo state restored {"sessionID":"ses_f2e036af4ffeoXuCloBC7STzba"}
```

The probe also saw `session.compaction.started x1 / delta x163 / ended x1` in the same run, and the
`compaction` hook fired with `agent: "Sisyphus - ultraworker"`.

## Still open

- Mid-turn compaction: does V2 continue by itself? Not measured. If it does not, omo needs a
  continuation dispatch here (through the shared gate), which would be a separate, evidence-led
  change.
- The `isCompactionAgent` guard has no V2 input: the event does not identify the compaction agent,
  and the hook reported the session's own agent. The duplicate guard is what remains.
