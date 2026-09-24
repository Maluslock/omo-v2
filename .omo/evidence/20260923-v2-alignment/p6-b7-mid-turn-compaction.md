# P6-B7: does V2 continue a turn across a mid-turn compaction? (2026-09-24)

## Question

V1's `experimental.compaction.autocontinue` resumed a session after a compaction. The omo-owned half
(state restore) was already ported to `session.compaction.ended` (commit `484f2aa`), but the host half
had no V2 equivalent, and an idle compaction on V2 was measured **not** to resume the turn. The open
question was the **mid-turn** case: when compaction happens while the agent is still working, does the
host keep going, or does omo need to inject a continuation prompt (the risky path the plan deliberately
avoided until measured)?

## Method

Isolated host, local dist, real config copy. The provider's declared context limit is lowered so a
single turn overflows it:

```jsonc
"deepseek": { "models": { "deepseek-v4-pro": { "limit": { "context": 70000, "output": 4000 } } } }
```

Two turns on one session (`--session <id>`), so the second has history to compact:

1. `Reply with exactly TURN_ONE_OK` -> `TURN_ONE_OK`.
2. `Now read data/file1.txt ... data/file6.txt one at a time using the read tool ... Then reply with
   exactly COMPACTION_PROBE_DONE` (6 files x ~16 KB).

A probe plugin recorded `session.compaction.*`, `session.execution.*`, `session.step.*` and the
provider request sizes (`live` probe source lives in the sandbox, not committed: it is a 20-line event
logger). Raw timeline: `.omo/tmp/compaction-live/events.jsonl`; transcript:
`.omo/tmp/compaction-live/run-t2.json`.

## Observed

Turn 2 (times relative to its first event):

```
+  8.4s  session.execution.started
+  8.8s  http.request                  166210
+ 10.3s  session.step.started / ended              <- read file1
+ 11.4s  http.request                  191121
+ 12.3s  session.step.started / ended              <- read file2
+ 14.4s  session.compaction.started
+ 14.4s  http.request                  171344
+ 18.7s  session.compaction.ended
+ 18.8s  http.request                  180320      <- the turn continues
+ 20.5s  session.step.started / ended              <- read file3
+ 21.9s  session.compaction.started
+ 28.9s  session.compaction.ended
+ 28.9s  http.request                  169102      <- continues again
+ 32.5s  session.step.started / ended              <- read file4
+ 33.5s  http.request                  184224
+ 34.9s  session.step.started / ended              <- read file5
+ 35.3s  session.compaction.started
+ 41.7s  session.compaction.ended
+ 41.9s  http.request                  170880      <- continues again
+ 43.9s  session.step.started / ended              <- read file6
+ 44.9s  http.request                  185993
+ 46.3s  session.step.started / ended
+ 46.3s  session.execution.succeeded
```

All six `read` calls completed (in order), the final assistant text was exactly
`COMPACTION_PROBE_DONE`, and the run exited 0. **Three compactions happened inside one turn and the
turn continued after each one** without any omo intervention.

omo's own half ran for every compaction:

```
[v2] compaction ended: omo state restored {"sessionID":"ses_f2d9f7a74ffem1bVhlqNuZW3f6"}   (x3)
[todo-continuation-enforcer] Session compacted: armed compaction guard {... "compactionEpoch":1}
[todo-continuation-enforcer] Session compacted: armed compaction guard {... "compactionEpoch":2}
[todo-continuation-enforcer] Session compacted: armed compaction guard {... "compactionEpoch":3}
```

The guard is what stops the enforcer from injecting a continuation prompt right after a compaction,
which is the correct V1 behavior and is why no duplicate/extra prompt appears in the timeline.

## Conclusion

- Mid-turn compaction continuation is **host-native on V2**. omo must not inject a continuation
  prompt for it, so the unported `experimental.compaction.autocontinue` host half is correctly
  unnecessary: the only omo-owned work is the state restore, which fires and is verified here in the
  mid-turn scenario (previously only the idle scenario had been probed).
- The remaining difference from V1 is the idle case: compacting an idle session (e.g. `/compact`) does
  not resume the turn on V2, which matches how the host is designed (there is no turn to resume).

## Caveat found while setting this up (environment, not a plugin bug)

With `limit.context` set to 24000 and 40000, every turn failed before producing anything:

```
{"type":"error","error":{"type":"compaction.unavailable","message":"Nothing to compact yet"}}
```

The base request (omo system prompt + tool definitions for the configured agent set) is already about
40k tokens / 162 KB, so a declared context limit below that makes the host attempt compaction before
any history exists and fail the turn. Plugins are not involved: the same failure occurs with the host's
own defaults. Recorded because it is an easy way to misdiagnose a "broken" V2 setup.

## What was omitted

Only synthetic prompts and probe-generated files were used; no real session content, prompts, or
credentials are recorded. The probe plugin used to capture the timeline was a throwaway event logger
and is not committed.
