# Full V2 event catalog for one turn (live capture, 2026-09-24)

## Why

`v2/hook-mapping.ts` translates V2 event envelopes into the V1 `{event: {type, properties}}` shape
that omo's ~55 hooks read. The table mapped `session.idle` and `session.compacted` straight through,
but those names come from the V1 vocabulary. If V2 never emits them, every V1 idle-keyed hook is dead
code on V2 - and a team probe showed exactly that symptom (a member session finished its turn while
its runtime status stayed `running`, so `team_send_message` live delivery never fired).

## How

Probe source (repo copy): `.omo/evidence/20260923-v2-alignment/live-v2-event-catalog-probe.ts`. A
plugin that subscribes to `ctx.event.subscribe({})` and appends every envelope's `type`, `data` keys,
and `data.sessionID` to a JSONL file. It runs alone (no omo) in an isolated XDG sandbox, driven by one
`opencode run --standalone` prompt against a real provider.

```
opencode run --standalone --format json --model deepseek/deepseek-v4-pro "Reply with exactly CATALOG_DONE"
```

Raw dump: `.omo/tmp/event-catalog/dump.jsonl`.

## Observed

Events with a `sessionID` for one prompt (the session-scoped stream, complete):

```
session.created
session.inbox.enqueued
session.inbox.delivered
session.instructions.updated
session.execution.started
session.step.started
session.step.streamed
session.text.started
session.text.delta
session.text.ended
session.step.ended
session.usage.updated
session.execution.succeeded
```

Whole-process stream also carried lifecycle-broadcast events (`session.*` absent): `agent.updated`,
`command.updated`, `integration.updated`, `model.updated`, `plugin.updated`, `provider.updated`,
`reference.updated`, `skill.updated`, `vcs.branch.updated`, `websearch.updated`,
`mcp.status.changed` (x16), `mcp.resources.changed`, `location.shutdown`.

**There is no `session.idle` and no `session.status`.** The turn envelope is
`session.execution.started` -> `session.execution.succeeded`, and steps stream
`session.step.started`/`session.step.streamed`/`session.step.ended` in between. The 2.0.15
`session-event.d.ts` schema in `research/pkgs/` lists the full vocabulary and confirms both names are
absent from it.

## Consequence

`v2/hook-mapping.ts` now maps the events V2 actually sends:

| V2 event | V1 event | Consumer that was dead before |
|---|---|---|
| `session.execution.succeeded` | `session.idle` | team member status -> idle (live delivery gate), `session-notification`, `runtime-fallback`, `first-prompt-watchdog`, compaction restore, `todo-continuation-enforcer`, claude-code `Stop` hook, atlas/ralph handlers |
| `session.compaction.ended` | `session.compacted` | `preemptive-compaction` state reset |

The pass-through entries for `session.idle` / `session.status` / `session.compacted` stay in the table
as forward-compatible no-ops (a host that emits them maps correctly); they are simply never hit on
2.0.11/2.0.15.

Deliberate omission: `session.execution.failed` and `session.execution.interrupted` are **not** mapped
to `session.idle`. Both end a turn, but synthesizing idle for them would fire continuation hooks
(`todo-continuation-enforcer`, claude-code `Stop`) on a turn the user aborted or that errored. They
keep their existing `session.error` mapping.

## What was omitted

Only `type`, `data` key names, and `sessionID` were recorded - no message text, prompts, or
credentials.
