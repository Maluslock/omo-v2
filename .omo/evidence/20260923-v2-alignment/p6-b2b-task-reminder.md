# Wired the never-wired `task-reminder` hook (2026-09-24)

## Why

`hooks/task-reminder/` has existed with its own unit test, but `createTaskReminderHook` was
referenced nowhere in the composition: it was dead code in V1 as well. With the task tools now
working on V2, nothing told the model to use them, so the feature would sit unused unless the user
asked for tasks explicitly.

## What changed

- `plugin/hooks/create-tool-guard-hooks.ts`: composes `taskReminder` behind
  `isHookEnabled("task-reminder")`, following the same `safeHook` pattern as its neighbours.
- `plugin/tool-execute-after.ts`: dispatches `hooks.taskReminder?.["tool.execute.after"]`.
- `plugin/event-hook-dispatcher.ts`: dispatches `hooks.taskReminder?.event` (the hook clears its
  per-session counter on `session.deleted`).
- `hooks/index.ts`: exports it from the barrel.
- `config/schema/hooks.ts`: `task-reminder` added to `HookNameSchema` (57 -> 58 values), so users can
  turn it off with `disabled_hooks`; `assets/omo.schema.json` and
  `assets/oh-my-opencode.schema.json` regenerated via `bun run build:schema`.
- Docs: the hook list in `docs/reference/configuration.md`, a row in the task-management hook table
  in `docs/reference/features.md`, the enum count in `config/AGENTS.md`, and the ToolGuard counts in
  `src/AGENTS.md` (18 [+1], total 54 base / 61 with team-mode).

Behaviour: after 10 consecutive tool calls that are not task tools, the reminder text is appended to
that tool's output; any task-tool call resets the counter.

## Live verification

Isolated project, omo loaded from the local dist, one message asking for 11 `omo_glob` calls:

```
omo_glob 调用次数: 11
带 reminder 的调用序号: [10]      (threshold is 10)
```

The reminder landed exactly on the 10th call, i.e. the hook fires and its output mutation reaches
the tool result on V2.

## Probe caveat (not a product bug)

In this sandbox `omo_glob` returned `Error: /usr/bin/grep: invalid max count`. The isolated
`XDG_CACHE_HOME` has no auto-downloaded ripgrep, so `resolveGrepCliWithAutoInstall()` fell back to
GNU grep, which rejects ripgrep-style arguments. The host's real environment spawns
`~/.cache/opencode/bin/rg`, so this is an isolation artifact. It is worth remembering when reading
isolated-host logs: grep-related failures there do not imply a defect.

## Suite

12898 pass / 13 fail - the same 13 pre-existing failures (the two full-suite flakes swapped again),
no new failures. Log: `full-test-taskreminder.log`.
