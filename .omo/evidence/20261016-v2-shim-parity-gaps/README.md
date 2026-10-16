# Live evidence: the three V2 client-shim parity fixes + `message.updated` synthesis (opencode 2.0.30)

Captured 2026-10-16 against **opencode v2.0.30** (`opencode v2.0.30`), plugin API
`@opencode-ai/plugin` 1.15.13, bun 1.3.14 — the same host the port was re-verified on
(`docs/reference/v2-port-summary.md` §8).

This directory answers one question: **do the client-shim parity fixes and the `message.updated`
synthesis actually work against a real host, on the code path no unit test can reach?** The unit
tests (`packages/omo-opencode/src/v2/client-shim.test.ts`, `packages/omo-opencode/src/v2/tool-mapping.test.ts`,
`packages/omo-opencode/src/v2/hook-mapping.test.ts`) use fake domains; here the probe imports the
production modules (`packages/omo-opencode/src/v2/client-shim.ts`, `packages/omo-opencode/src/v2/tool-mapping.ts`,
`packages/omo-opencode/src/v2/event-subscription.ts`), builds the shim from the **host's own** `ctx`,
and is invoked by a **real tool call**, in a real session, on a real server, followed by a real
interrupt.

| # | Fix | Verdict | Witness |
|---|-----|---------|---------|
| 1 | `session.summarize` → `ctx.session.compact` | **works** | `SUMMARIZE_RESOLVED=yes`, `SUMMARIZE_ERROR=NONE`, and the host drove a full compaction of the target session: `session.compaction.started` → `session.compaction.delta` ×2 → `session.compaction.ended` |
| 2 | `session.create` forwards `parentID` | **works** | `CREATE_REQUESTED_PARENTID` = `CREATE_RETURNED_PARENTID` = driver session, and an independent host `GET /api/session/{id}` reports the same parent: `CHILD_PARENT_MATCH=yes` |
| 3 | tools receive the host's own `AbortSignal` | **works** | `ABORT_OBSERVED=yes`, `ABORT_OUTCOME=aborted`, `ABORT_ABORTED=True` ~2s after `POST /api/session/{sessionID}/interrupt` |
| 4 | `message.updated` rebuilt from the V2 step events | **works** | `V1_MESSAGE_UPDATED=3`, `V1_MESSAGE_UPDATED_FINISHED=1`, `ROLE=assistant`, `PROVIDER=mock`, `MODEL=mock-1`, `TOKENS=yes`, `TIME=yes` — see `out/probe8-v1events.txt` |

Verdicts 1–3 come from the same run (`out/probe7-shim-parity.txt`); verdict 4 is the next run of the
same runner (`out/probe8-shim-parity-mapper.txt`), after the probe gained the V1 pipeline.

`ISO=ISO_OK` (`297` → `297` rows in the real `~/.local/share/opencode/opencode.db`): every session
this run created lives in the throwaway XDG root.

## Run it

```bash
bash .omo/evidence/20261016-v2-shim-parity-gaps/run-shim-parity-probe.sh
```

~2 minutes, no arguments, no state carried between runs (isolated `XDG_*` + a fresh port). It needs
`opencode` v2.0.30 on `PATH` and `python3`; the mock provider (OpenAI-compatible, `aisdk:@ai-sdk/openai-compatible`)
plays the model. Captures land in the repo's `.omo/tmp/shim-parity-probe/` (`probe.jsonl`,
`mock-bodies.jsonl`) and are destructively useless after the sandbox is deleted, so the run used for
this document was copied here:

| File | What it holds |
|------|---------------|
| `out/probe7-shim-parity.txt` | the runner's 40 verdict lines for fixes 1–3 (verbatim, unabridged) |
| `out/probe7-probe.jsonl` | the probe's NDJSON: 9 records + 9 events, one per line |
| `out/probe7-probe-records.txt` | the 9 records alone, for reading |
| `out/probe8-shim-parity-mapper.txt` | the same verdicts plus the `V1_MESSAGE_UPDATED*` block (verdict 4) |
| `out/probe8-v1events.txt` | the three synthesized `message.updated` events, verbatim |
| `out/probe8-probe.jsonl` / `out/probe8-probe-records.txt` | the full NDJSON of that run, and the records alone |

## How each verdict is obtained

The probe plugin (`zz-shim-parity-probe.ts`) registers **one** V1 tool through the production
`toV2Tool` + `ctx.tool.transform` path (`namespace: "zzprobe"` → the host exposes it as
`zzprobe_zz_shim_probe`). The mock answers the driver session with a `tool_calls` response
(`--tool-call` + `--tool-call-marker PROBE_MARKER`), so the host — not the probe — decides when the
tool runs. `mode="all"` then, in order:

1. `shim.session.create({ body: { parentID: <driver session> } })` — records requested vs returned
   parent, and the probe catches any rejection instead of letting it escape.
2. reads the donor session id from `$SHIM_PROBE_TARGET_FILE` and calls
   `shim.session.summarize({ path: { id: <donor> } })` — `resolved: true` is the shim's own answer;
   the proof that a compaction really happened is the host's `session.compaction.*` events, which
   the probe's event subscription records **by session id**.
3. `await context.abort` (45s cap), then records `{outcome, aborted}` and returns.

Then the runner, externally: reads the child session back from the host (fix 2, second witness),
discovers the interrupt route from `/openapi.json` at runtime — never hard-coded, per the 2026-10-16
recheck — and interrupts the driver session (fix 3). The tool's `await context.abort` can only
resolve if the signal the host passed to the tool is the one the interrupt fires.

**Verdict 4** reuses the same runner and sessions, but the probe also starts the production V2 → V1
pipeline (`startV2EventSubscription` from `packages/omo-opencode/src/v2/event-subscription.ts`,
which owns the stateful `createV1EventMapper`) with a recorder in place of omo's assembled V1
handler. V2 emits no `message.updated` at all — the event is V1-namespace only — so any
`message.updated` record is the synthesis itself, on live payloads: three arrived, and the donor's
step produced the full pair (`finish: null` + `hasTokens: false` from `session.step.started`, then
`finish: "stop"` + `hasTokens: true` + `time.completed` from `session.step.ended`), both carrying the
`providerID`/`modelID`/`agent` that only `session.step.started` knows
(`out/probe8-v1events.txt`). The driver's step shows the other half: its `started` half arrived and
its `ended` half never did, because the run interrupts it.

## What this capture does **not** prove

- **Not** a `dist/` regression run. The probe imports `src/` on purpose: `dist/` may lag the fix
  under test. Whole-plugin regression is the 2026-10-16 16:27–16:29 suite run
  (`run-recheck-all.sh` in `.omo/evidence/20261016-opencode-2030-recheck/`, after `bun run build`
  with these fixes): every stage reported `rc=0` and rewrote all 11 captures plus the schema-diff
  and real-DB checks in that directory's `out/`; the run log is
  `out/probe7-regression-progress.txt` here. Both belong to the same change.
- **Not** summary quality. The compaction's model reply is a fixed template
  (`summary-fixture.md`), so `session.compaction.ended` proves the *plumbing* (shim → `ctx.session.compact`
  → host compaction loop → events), not that a good summary was produced. The first capture of this
  run showed `session.compaction.failed` purely because the mock replied `TURN_DONE`; the failure
  event itself is further proof the host ran the compaction.
- **Not** a differential A/B of the old code. The counterfactual is structural and cited, not
  executed: before the fix `summarize` read a `session.compact` domain method that the shim never
  exposed, so the call threw a `TypeError` that the V1 call sites swallow (see the module doc in
  `packages/omo-opencode/src/v2/client-shim.ts`), and the fallback `AbortSignal` was a fresh
  `AbortController().signal` that nothing could ever abort.
- **Not** fix 3's `2.0.11` fallback. On a host without `context.signal` the shim still fabricates a
  non-aborting signal; that branch is covered by unit test
  (`packages/omo-opencode/src/v2/tool-mapping.test.ts`, "supplies a distinct abort signal per execute
  call when the host exposes none"), not by this live run.
- **Not** proof that every `message.updated` consumer now behaves. Verdict 4 proves the event reaches
  the V1 pipeline with the fields the hooks read; what each hook then does with it is separate (and
  partly covered by the hook suites). The recorder deliberately stands in for omo's assembled
  handler, so this capture cannot show, say, preemptive compaction firing end to end.
- **Not** a `message.updated`-for-every-part claim. Only assistant steps are synthesized (the
  `session.step.*` pair); V1's `message.part.updated` remains unmapped and its consumers
  (`packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts`,
  `packages/omo-opencode/src/hooks/session-notification.ts`,
  `packages/omo-opencode/src/hooks/ralph-loop/event-handler-activity.ts`) still sleep on V2.

## Two host facts this run pinned down

- **Project plugins load lazily, on the first turn.** The first capture asserted registration before
  sending any prompt and printed `PROBE_REGISTERED=0` — a false failure; `setup` had simply not run
  yet. The runner now records `PLUGIN_LOAD=lazy_first_turn` and asserts registration after the driver
  turn (`PROBE_REGISTERED=1`, `PROBE_SETUP=yes`). This is the same laziness behind the missing
  `session.created` for sessions created before a host's first prompt.
- **The interrupt route is `POST /api/session/{sessionID}/interrupt`** (HTTP 200), discovered from
  `/openapi.json`; `session.compact` exists on 2.0.30's plugin session domain
  (`HOST_HAS_SESSION_COMPACT=function`), which is why fix 1 can work at all.

## Files

| File | Role |
|------|------|
| `run-shim-parity-probe.sh` | the runner: isolated XDG, mock, server, donor + driver sessions, interrupt, verdicts, ISO check |
| `zz-shim-parity-probe.ts` | the probe plugin: registers `zzprobe_zz_shim_probe`, drives the three shim calls, and runs the production V2 → V1 pipeline (`startV2EventSubscription`) with a recorder, all to NDJSON |
| `mock-provider.py` | mock model: plain text, or `tool_calls` when a marker is present; answers summary requests from `summary-fixture.md` |
| `summary-fixture.md` | a template-shaped summary so the host's compaction can finish |
| `out/` | the capture this document cites |
