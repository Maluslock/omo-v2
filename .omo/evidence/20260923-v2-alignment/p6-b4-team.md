# P6-B4: team tools ported to V2 (2026-09-24)

## Why

All 12 `team_*` tools were on the `CLIENT_DEPENDENT_TOOLS` denylist with the note "every team tool
factory receives `ctx.client` and drives tmux/worktree orchestration". Reading the factories shows
that claim was wrong in both halves:

- **10 of the 12 factories never read `client` at all** - they take it and immediately `void client`
  (`query.ts`, `tasks.ts`, `lifecycle-shutdown-tools.ts`). Their work is `team-core` state store,
  mailbox and tasklist file IO.
- The **2 real uses** are already V2-native: `team_create` hands `client` into `ExecutorContext`,
  whose only consumer is the background manager (`session.create`/`get`/`abort`/`todo`/`status`,
  which the shim serves), and `team_send_message` live delivery goes through the shared prompt gate.
- tmux layout (`activateTeamLayout`) returns immediately unless `tmux_visualization` is enabled;
  worktree orchestration is plain git.

So the block was a stale denylist entry, not a missing capability.

## What changed

- `v2/register-tools.ts`: the 12 `team_*` names moved from `CLIENT_DEPENDENT_TOOLS` to
  `SHIM_UNLOCKED_TOOLS`; the doc comment now records what each unlocked family actually needed.
  `CLIENT_DEPENDENT_TOOLS` is down to `skill` alone (the host ships its own, so omo's stays out).
- `v2/register-tools.test.ts`: the unlocked-surface test now pins all 12 registrations.

Two blocking V2 gaps surfaced while probing the team flow and were fixed in the same change - see
`p6-b5-background-liveness-and-idle-mapping.md`: a live subagent was being killed after ~9s because
the shim had no `session.status`, and team member status never left `running` because V1
`session.idle` has no V2 counterpart.

## Live verification (isolated host, real omo dist bundle)

Sandbox: `.omo/tmp/team-probe` (fresh XDG roots, project-local `.opencode/plugins/omo-local.ts`
pointing at the locally built `dist/index.js`), `team_mode.enabled: true`,
`base_dir` pinned inside the sandbox, `categories.quick.model = deepseek/deepseek-v4-pro`.

Registration, from the plugin log:

```
[tool-registry] Built tool registry {"totalTools":26,"teamModeEnabled":true,"teamToolCount":12}
[v2] tools registered {"registered":25,"skipped":1,"skippedTools":["skill"]}
```

Full lifecycle in one `opencode run --standalone --format json` message (raw:
`.omo/tmp/team-probe/run-flow3.json`):

```
omo_team_create      -> teamRunId c984deb0-... | status active | probe-lead.sessionId = caller session
                        probe-worker.sessionId  = ses_f2db52673ffeLmSwCmPhYnbxzI (new session)
omo_team_status      -> probe-worker running, then idle
omo_team_send_message-> {"messageId":"efc85367-...","deliveredTo":["probe-worker"]}
omo_team_delete      -> {"deleted":true,"removedWorktrees":[],"removedLayout":false}
```

A second run exercised the file-backed half of the family
(`.omo/tmp/team-probe/run-flow.json`):

```
omo_team_task_create -> {"taskId":"1","task":{"subject":"probe task","status":"pending",...}}
omo_team_task_get    -> the same record
omo_team_task_list   -> {"tasks":[{...id "1"...}]}
```

The member really ran: the isolated DB shows its session with the team prompt, a real assistant
reply `PROBE_WORKER_OK`, `idle outcome: succeeded`, and the injected peer message:

```
[user  seq=5]  "Team: probe-team\nTeamRunId: c984deb0-...\nMember: probe-worker\nReply with exactly PROBE_WORKER_OK..."
[assistant seq=6] text=["PROBE_WORKER_OK"]
[idle  seq=13] {"outcome":"succeeded"}
[user  seq=18] "<peer_message from=\"probe-lead\" messageId=\"efc85367-...\">\nLIVE_DELIVERY_PROBE\n</peer_message>"
```

The member also called a team tool itself (`omo_team_task_list` from inside the member session),
which proves the registry is available to sub-sessions, not only the lead.

Live delivery path, from the plugin log:

```
[team-mailbox] live delivery reserved until recipient idle {"recipient":"probe-worker", ...}
```

Tools exercised live: `team_create`, `team_status`, `team_send_message`, `team_task_create`,
`team_task_get`, `team_task_list`, `team_delete` (7 of 12). `team_list` ran in the registration
probe and returned `[]` on a clean sandbox. The three shutdown-handshake tools
(`team_shutdown_request`/`team_approve_shutdown`/`team_reject_shutdown`) and `team_task_update` share
the same factories and deps as the tools above (same `void client`, same `team-core` store) and are
covered by their existing unit suites rather than the live probe.

## Unit verification

`bun test packages/omo-opencode/src/v2/ packages/omo-opencode/src/plugin/` -> 584 pass, 0 fail.
`tsgo --noEmit` exits 0.

## Regression check

Full `bun test`: see the summary appended by the run recorded in
`p6-b5-background-liveness-and-idle-mapping.md`; the failure set is the pre-existing baseline.

## Why this is enough

- The denylist change is exactly the capability claim under test, and the live run drives the real
  bundle end to end: create (with a spawned background member session), status, messaging with live
  delivery, task CRUD, delete.
- The two V2 gaps the probe exposed were fixed with their own unit tests and their own before/after
  live evidence, so a future regression in either shows up as a failing test and a failing probe.

## What was omitted

- All probe output is synthetic (`PROBE_WORKER_OK`, `LIVE_DELIVERY_PROBE`); no secrets or user data.
- The sandbox uses an inline 2-member spec with a `quick` category model. Larger teams, worktrees and
  tmux visualization are not exercised (tmux layout is opt-in and behind `tmux_visualization`).

## Residual risk

- The three shutdown-handshake tools are not driven live; they share the delete/participant resolver
  that `team_delete` exercised, so the risk is limited to their own state transitions.
- Team members inherit the background manager's liveness behavior; that is now correct for normal
  turns but still depends on the event stream staying connected (bounded by the 90s activity TTL).
