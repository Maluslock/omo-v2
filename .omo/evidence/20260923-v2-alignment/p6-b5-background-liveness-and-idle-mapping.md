# P6-B5: background-agent liveness and the V1 idle mapping on V2 (2026-09-24)

Two V2 gaps that the team probe surfaced. Both are ports of behavior the V1 host provides for free,
and both affect more than team mode: every background subagent (`task`, `call_omo_agent`, team
members) and every idle-keyed hook.

## Gap 1 - a live subagent was treated as a gone session and stopped after ~9s

### Why

`client.session.status` has no V2 domain method, so the shim answered with an empty map. The
background manager reads a missing entry as "session no longer in the status registry" and increments
`task.consecutiveMissedPolls` on every poll; after `MIN_SESSION_GONE_POLLS` (=3, ~9s at the 3s poll
interval) it completes the task and stops the session, as long as the session has produced *any*
output. So a subagent that emits one tool call and then keeps working was cut off mid-turn.

### Before (team probe, first run)

```
07:07:18 [background-agent] Polling idle/gone but no valid output yet, waiting: "bg_0ec34358"
07:07:21 [background-agent] Polling idle/gone but no valid output yet, waiting: "bg_0ec34358"
07:07:24 [background-agent] Task completed via polling (session gone from status): "bg_0ec34358"
07:07:24 [auto-compact] session.error received {"sessionID":"ses_...","error":{"type":"aborted","message":"Step interrupted"}}
07:07:24 team member session errored {"event":"team-mode-member-errored","memberName":"probe-worker"}
```

The member's own transcript shows it was mid-work: its first assistant message (with a completed
`omo_team_task_list` tool call) closed at 24.4s and the next one was streaming when the abort landed
at 24.8s. It never produced its final answer.

### Fix

`v2/session-activity.ts` reconstructs the status map from the host event stream, which does publish
the turn envelope (`session.execution.started` -> `session.execution.succeeded|failed|interrupted`)
plus per-step and per-delta heartbeats. The tracker reports `{type:"busy"}` for sessions whose
envelope is open, with:

- a **90s staleness TTL** refreshed by heartbeats (`session.step.streamed`, `session.text.delta`,
  `session.tool.progress`, ...). A live session never expires; a crashed one stops masking itself
  after 90s instead of relying on the manager's 45-minute stale timeout.
- a **500-entry cap** with least-recently-active eviction, so one host serving many sessions cannot
  grow the map without bound.
- an observation feed that rides the session index's existing `ctx.event.subscribe` loop (no third
  event stream), and a `status()` that returns the map.

Only busy sessions are reported: reporting `idle` for finished ones would change the completion path
(`sessionMissing` would stay false) for no benefit.

### After (team probe, third run)

```
07:21:59 [background-agent] Session still running, relying on event-based progress: {"sessionStatus":"busy","toolCalls":0}
07:22:00 team member idled {... "previousStatus":"running","nextStatus":"idle"}
07:22:02 [background-agent] Task completed via polling (session gone from status)   <- after the turn ended naturally
```

and the member transcript now ends the turn properly:

```
[assistant seq=6] text=["PROBE_WORKER_OK"]
[idle seq=13] {"outcome":"succeeded"}
```

Unit coverage: `v2/session-activity.test.ts` (11 cases - envelope busy/idle per terminal outcome,
multi-step turns, heartbeats, TTL expiry, `session.deleted`, unrelated events, busy-only reporting,
cap eviction, re-observation refresh) plus a shim test that `session.status` tracks a live session and
still returns an empty `todo` stub.

## Gap 2 - V1 `session.idle` never fired, so every idle-keyed hook was dead

### Why

`v2/hook-mapping.ts` translated V2 envelopes into the V1 `{event:{type,properties}}` shape, and its
table carried `"session.idle": "session.idle"`. That name belongs to the V1 vocabulary. A full-catalog
live capture (`.omo/evidence/20260923-v2-alignment/live-v2-event-catalog.md`) shows one prompt emits
`session.created`, `session.inbox.*`, `session.instructions.updated`,
`session.execution.started`, `session.step.started/streamed/ended`, `session.text.*`,
`session.usage.updated`, `session.execution.succeeded` - and **no `session.idle`** (the 2.0.15
`session-event.d.ts` schema in `research/pkgs/` agrees). `session.compacted` and `session.status` are
likewise never emitted.

Symptom in the team probe: the member's runtime status stayed `running` after its turn ended, so
`team_send_message` could never use live delivery and always fell back to the inbox.

```
[team-mailbox] live delivery unavailable, recipient is not idle {"reason":"recipient-not-idle","status":"running"}
```

### Fix

`v2/hook-mapping.ts` now maps the events V2 actually sends:

| V2 event | V1 event | Consumer |
|---|---|---|
| `session.execution.succeeded` | `session.idle` | team member status -> idle, `session-notification`, `runtime-fallback`, `first-prompt-watchdog`, compaction restore, `todo-continuation-enforcer`, claude-code `Stop` hook, atlas/ralph handlers |
| `session.compaction.ended` | `session.compacted` | `preemptive-compaction` state reset |

`session.execution.failed` / `session.execution.interrupted` are deliberately **not** mapped to idle:
both end a turn, but synthesizing idle for them would fire continuation hooks on a turn the user
aborted or that errored. They keep their existing `session.error` mapping. The pass-through entries for
`session.idle` / `session.status` / `session.compacted` stay as forward-compatible no-ops.

### After (team probe, third run)

```
07:22:00 team member idled {"event":"team-mode-member-idled","previousStatus":"running","nextStatus":"idle"}
07:22:05 [team-mailbox] live delivery reserved until recipient idle {"recipient":"probe-worker",...}
```

and the injected message landed in the member session:

```
[user seq=18] "<peer_message from=\"probe-lead\" messageId=\"efc85367-...\">\nLIVE_DELIVERY_PROBE\n</peer_message>"
[assistant seq=19] parts=['reasoning','tool']   <- the member acted on it
```

Unit coverage: `v2/hook-mapping.test.ts` pins the two new mappings and the missing-`sessionID`
rejection.

## Regression check

Full `bun test` after both fixes: **12917 pass / 3 skip / 13 fail**. The 13 failures are the known
pre-existing baseline (auto-slash-command x4, auto-update-checker/checker x5 mock-isolation flake,
`command.execute.before` x1, DMCA provenance x1, install-codex/Codex version sync x2). Pass count rose
by 12 over the previous run (11 tracker + 2 mapping tests, minus the rewritten shim test).
`tsgo --noEmit` exits 0.

## Why this is enough

- Both gaps have a before/after pair from the same probe, on the real bundle, with the host-side log
  as the source of truth (`sessionStatus:"busy"`, `team-mode-member-idled`, `live delivery reserved`).
- The failure mode was reproduced first (premature abort at 24.8s, live delivery unavailable) and is
  gone in the rerun, so the fix is tied to the observed defect rather than to a hypothesis.
- The unit tests pin the decision tables (busy/ended event sets, TTL, cap, mapping table) so a future
  refactor cannot silently re-break either.

## What was omitted

- No prompts, message bodies, or credentials from the real config are recorded; all probe traffic is
  synthetic.
- The 90s TTL and 500-entry cap are chosen, not measured against a production workload; the rationale
  (heartbeat cadence vs. the manager's own 45-minute stale timeout) is documented in the module.

## Residual risk

- Both fixes depend on the host event stream staying connected. If it drops mid-turn, a session stays
  busy until the TTL expires (90s), which is still shorter than the V1 stale timeout.
- Mapping `session.execution.succeeded` to `session.idle` also fires for non-primary executions that
  share a session (for example a compaction-driven execution). Those paths were already idle-keyed on
  V1, and the affected handlers guard on their own state, but it is the one place where V2's
  vocabulary is coarser than V1's.
