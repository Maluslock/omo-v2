# Live evidence: the V2 parity fixes: client shim, `message.updated`, `session.created` (opencode 2.0.30)

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
| 5 | `session.created` announced for a session that predates the subscription | **works** | `V1_SESSION_CREATED` lists all three sessions but `RAW_SESSION_CREATED` only the two created after the plugin loaded: `V1_CREATED_WITHOUT_RAW=ses_ebc23254affe8A5G0ryhk3bUmc` - the donor session, announced in the same millisecond as its first `message.updated`, while the driver and child kept their real, titled events — see `out/probe9-created-events.txt` |
| 6 | `message.part.updated` / `message.part.delta` rebuilt from the V2 part streams, and the interrupt mapped to `session.stop` | **works** | `V1_PART_UPDATED=6`, `V1_PART_DELTA=1`, `V1_PART_KINDS=text,tool`, `V1_PART_FIELDS=text`, `V1_SESSION_STOP=1`, while the raw stream carried only `session.text.*` / `session.tool.*` / `session.execution.interrupted` (`RAW_STREAM_TYPES` in the same capture) — see `out/probe10-parts.txt` |
| 7 | V1 `system` / `tools` on a create/prompt body, replayed onto the V2 request | **works** | the shim recorded `{system: ["ZZPROBE_SYSTEM_MARKER"], tools: {bash:false, task:false, zz_probe_shadow:false}}`, and the provider saw the difference: the two pre-recording requests kept the host's whole advertised set (`shell=yes subagent=yes shadow=yes`, 14 tools), the two after lost exactly those three (`marker=yes shell=no subagent=no shadow=no`, 11 tools, `question` untouched). The third denial is the interesting one: the body named it bare while the host advertises it namespaced (`omo_zz_probe_shadow`, see `MOCK_FIRST_REQUEST_TOOLS`), so `MOCK_REQUESTS_WITH_OMO_SHADOW_TOOL=2` (the requests before the recording) proves the namespaced resolution fired — `MOCK_REQUEST_ROW` in `out/probe13-session-prompt-config.txt`, with `MOCK_REQUESTS_WITH_HANDROLLED_MARKER=0` |

Verdicts 1–3 come from the same run (`out/probe7-shim-parity.txt`); verdict 4 is the next run of the
same runner (`out/probe8-shim-parity-mapper.txt`), after the probe gained the V1 pipeline; verdict 5 is
the run after that (`out/probe9-session-created.txt`), which also records the raw stream so a
synthesized creation can be told from a delivered one. Verdict 6 is the run after that
(`out/probe10-part-events.txt`), where the probe's V1 recorder also counts the part events and the
interrupt. Verdict 7 is the last run (`out/probe13-session-prompt-config.txt`), where the probe also
registers the production request-config bridge and the runner compares the provider requests made
before and after the shim recorded a V1 body's `system`/`tools`.

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
| `out/probe9-session-created.txt` | the verdicts again, now with `V1_SESSION_CREATED` / `RAW_SESSION_CREATED` / `V1_CREATED_WITHOUT_RAW` |
| `out/probe9-created-events.txt` | every `session.created`, raw and V1, in order |
| `out/probe9-probe.jsonl` / `out/probe9-probe-records.txt` | the full NDJSON of that run, and the records alone |
| `out/probe10-part-events.txt` | the verdicts again, now with `V1_PART_UPDATED` / `V1_PART_DELTA` / `V1_PART_KINDS` / `V1_PART_FIELDS` / `V1_SESSION_STOP` / `RAW_STREAM_TYPES` |
| `out/probe10-parts.txt` | every rebuilt part event and `session.stop`, in order, with the id that ties a start/delta/end to one part |
| `out/probe10-probe.jsonl` / `out/probe10-probe-records.txt` | the full NDJSON of that run, and the records alone |
| `out/probe13-session-prompt-config.txt` | the verdicts again, now with `PROMPTCONFIG_*` and one `MOCK_REQUEST_ROW` per provider request |
| `out/probe13-probe.jsonl` / `out/probe13-probe-records.txt` | the full NDJSON of that run (48 records), and the records alone |
| `out/probe13-regression-after-parity.txt` | the whole-plugin regression on the final `dist/` (every stage `rc=0`, 2026-10-16 17:07–17:08) |

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

**Verdict 5** makes the raw subscription record `session.created` too, so the two streams can be
compared. The donor session is prompted before the plugin exists (project plugins load lazily, on their
first turn), so its creation is on no subscriber's stream; the V1 pipeline still announced it, in the
same millisecond as its first `message.updated` (`title: null` - the payload that would have carried the
title is gone). The driver and child sessions were created while the plugin was live, and each kept its
single real event, title included: nothing was announced twice.

**Verdict 6** needs no new machinery: the same recorder was widened to the part events and
`session.stop`. The raw stream of that run contains no `message.part.*` at all - it carries
`session.text.started/delta/ended`, `session.tool.input.started/input.ended/called/failed` and
`session.execution.interrupted` - yet six `message.part.updated`, one `message.part.delta` and one
`session.stop` reached the V1 pipeline. The donor's text part is the whole V1 lifecycle on one id
(`msg_…:text:0`): `updated` (empty text) → `delta` (`field: "text"`) → `updated` (assembled text); the
driver's tool call is four `updated` events on its call id, ending in `error`; and the `session.stop`
lands after them, at the interrupt. Those are the events the activity-keyed hooks listen to
(`packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts:72`,
`…/ralph-loop/event-handler-activity.ts:37`, `…/session-notification.ts:121`,
`…/compaction-context-injector/hook.ts:143`, `…/atlas/event-handler.ts:66`,
`…/todo-continuation-enforcer/non-idle-events.ts:162`), which were all dormant on V2 before it.

**Verdict 7** drives the other bridge omo needs, the per-session request config
(`packages/omo-opencode/src/v2/session-prompt-config.ts`). V1's `session.create` / `session.prompt`
body could carry `system` and `tools`; V2's forms have no such fields, so the shim hands them to the
registry and the assembly replays them from the `context` hook. The probe registers the *production*
replay hook (`registerOmoSessionPromptConfigHook` from `packages/omo-opencode/src/v2/register-hooks.ts`)
the way `packages/omo-opencode/src/v2/register-hook-assembly.ts` does, then calls
`shim.session.promptAsync` with `system: "ZZPROBE_SYSTEM_MARKER"` and
`tools: {bash: false, task: false, zz_probe_shadow: false}` for the driver session. The probe also
registers a second tool under the `omo` namespace (`omo_zz_probe_shadow`), because omo's own tools
are advertised with that prefix (`packages/omo-opencode/src/v2/register-tools.ts` builds the id as
`${NAMESPACE}_${tool.name}`) while V1 bodies deny them by bare name - that is the third denial, and
the one that would silently fail without the prefix attempt. What the shim recorded (`PROMPTCONFIG_RECORDED_SYSTEM`,
`PROMPTCONFIG_RECORDED_TOOLS=bash,task`) is only the middle of the chain; the verdict is the provider's
view, printed per request as `MOCK_REQUEST_ROW`. The driver's requests before the recording carry the
host's full advertised set (`shell=yes subagent=yes shadow=yes`, 14 tools); the requests after it carry
the system part and lost exactly the three denied names - two through the action translation
(`bash`→`shell`, `task`→`subagent`) and one through the namespace prefix
(`zz_probe_shadow`→`omo_zz_probe_shadow`) - leaving `question` in place. Run it with
`SHIM_PROBE_MODE=session-prompt-config SHIM_PROBE_MUTATE_CONTEXT=0 SHIM_PROBE_SETTLE_SECONDS=8`:
the hand-rolled `context` hook the probe uses for probe11/probe12 stays off, and it pushes a different
literal, so `MOCK_REQUESTS_WITH_HANDROLLED_MARKER=0` proves the marker came from the production path.

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

- **Not** a `dist/` regression run of the probe itself. The probe imports `src/` on purpose: `dist/`
  may lag the fix under test. Whole-plugin regression is a separate suite
  (`run-recheck-all.sh` in `.omo/evidence/20261016-opencode-2030-recheck/`, after `bun run build` with
  all of these fixes): every stage reported `rc=0` and rewrote all 11 captures plus the schema-diff and
  real-DB checks in that directory's `out/`. It was run twice - 16:27–16:29 after the shim fixes
  (`out/probe7-regression-progress.txt` here) and 17:07–17:08 on the final `dist/`
  (`out/probe13-regression-after-parity.txt`, 20 lines, ten stages).
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
- **Not** a full reconstruction of the missed creation. The announcement carries the session id and no
  title or `parentID`, because the event that would have carried them was never delivered; a hook that
  needs the title has to read the session.
- **Not** a claim about what each part consumer does. Verdict 6 proves `message.part.updated`,
  `message.part.delta` and `session.stop` reach the V1 pipeline on V2 with a stable part id; the
  handlers that key off them (`packages/omo-opencode/src/hooks/runtime-fallback/first-prompt-watchdog.ts`,
  `packages/omo-opencode/src/hooks/session-notification.ts`,
  `packages/omo-opencode/src/hooks/ralph-loop/event-handler-activity.ts`) are covered by their own suites.
- **Not** message-scoped semantics for verdict 7. In V1 the `system`/`tools` rode one create/prompt
  body; this bridge is session-scoped, so it applies to every later request of that session until it is
  replaced or the session is deleted - V2 has no message-scoped channel. The capture shows the *next*
  requests, not "only that message's request".
- **Not** proof that `registerOmoHooks` calls the bridge. The probe registers
  `registerOmoSessionPromptConfigHook` directly (mirroring `packages/omo-opencode/src/v2/register-hook-assembly.ts`);
  that the assembly wires it, with the other seven registrations and their disposal, is the unit test
  in `packages/omo-opencode/src/v2/register-hook-assembly.test.ts`.
- **Not** proof for delegated members or compaction requests. Only the ordinary prompt requests of the
  two sessions in this run were observed.
- **Not** proof about omo's real tool ids for verdict 7. The namespaced denial is proven with a
  synthetic tool the probe registers under the same `omo` prefix (`omo_zz_probe_shadow`) that
  `packages/omo-opencode/src/v2/register-tools.ts` uses for omo's own tools; the real `omo_look_at` /
  `omo_task_create` ids are not exercised here, and the bare-name denials omo actually passes
  (`features/background-agent/spawner/task-prompt-body.ts`, `tools/look-at/look-at-session-runner.ts`)
  are covered by `packages/omo-opencode/src/v2/session-prompt-config.test.ts` instead.

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
