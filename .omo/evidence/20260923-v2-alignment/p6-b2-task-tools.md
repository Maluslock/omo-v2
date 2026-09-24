# P6-B2 `task_create` / `task_get` / `task_list` / `task_update` on V2 (evidence)

Date: 2026-09-24

## What was actually blocking them

The plan listed these as blocked because "`todo-sync` reads `ctx.client.session.todo`; V2 removed
todos". Reading the code changes the picture:

- the tools persist tasks as plain JSON files (`getTaskDir(config)` + `writeJsonAtomic`), which works
  on V2 unchanged;
- `syncTaskTodoUpdate` is fail-soft by construction: it reads `ctx.client.session.todo` (the shim's
  honest empty stub), then tries to resolve `opencode/session/todo`, fails, and returns. Observed live:
  `[todo-sync] TodoSync unavailable ... ResolveMessage: Cannot find package 'opencode'` and **no
  throw**;
- the real gate is config: `shared/task-system-enabled.ts` is `config.experimental?.task_system ?? false`.

So the port was: unblock them in `CLIENT_DEPENDENT_TOOLS`, plus two fixes the live probe exposed.

## Fix 1 — the task list must follow the project, not the server's cwd

`getTaskDir` falls back to `<config dir>/tasks/<basename(process.cwd())>`. V1 ran a process per
project, but one V2 server serves every project location, so all projects would share one task list.
`withLocationTaskListId(config, ctx.location.directory)` now supplies the id when the user set neither
`sisyphus.tasks.task_list_id` nor `ULTRAWORK_TASK_LIST_ID` (an explicit `storage_path` still wins).

Live: tasks landed in `<xdg config>/opencode/tasks/proj/*.json` for a project directory named `proj`.

## Fix 2 — parallel task writes lost the lock

The first live run had the model create two tasks in one message; `acquireLock` makes exactly one
retry, so one call returned `{"error":"task_lock_unavailable"}` and the model had to retry.
`acquireLockAsync(dir, {timeoutMs: 2000, intervalMs: 25})` waits for the lock instead of failing on
first contention; the file lock stays the cross-process guard. Before/after, same prompt:

| run | task tool calls | `task_lock_unavailable` | task files |
|---|---|---|---|
| before | 4 (one was a retry) | 1 | 2 |
| after | 4 | **0** | 2 |

Also: `todo-sync` now remembers that `Todo.update` is unresolvable and logs once per process instead
of on every task write (was 3 lines for 3 writes).

## Live verification

Project config `[opencode].experimental.task_system = true`, omo loaded from the local dist, tool
turn through the model:

```
[v2] tools registered {"registered":17,"skipped":1,"skippedTools":["skill"]}
  omo_task_create status=completed  {"task":{"id":"T-763ffac5-...","subject":"TASK_ALPHA"}}
  omo_task_create status=completed  {"task":{"id":"T-7355ec93-...","subject":"TASK_BETA"}}
  omo_task_list   status=completed  {"tasks":[...]}
  omo_task_update status=completed  {"task":{...,"status":"completed","...}}
```

17 = the previous 13 plus all four task tools (they were absent from the registry entirely while the
gate was off, which is why only `skill` was listed as skipped).

## Notes

- The task system is OFF by default (`experimental.task_system ?? false`). Enabling it is the user's
  choice: `{ "[opencode]": { "experimental": { "task_system": true } } }`.
- Host todo mirroring is genuinely gone on V2 (there is no todo tool at all), so the task files are
  the only record. Continuation hooks that used to read host todos have nothing to read.
- The lock fix and the per-location list id also improve the V1 host path (both are strictly less
  contention and less cross-project mixing).
