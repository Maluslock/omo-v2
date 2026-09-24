# P5-A4 `shell.hook("create.before")` — assessment: nothing to port (2026-09-24)

The plan listed V1 `shell.env` -> `ctx.shell.hook("create.before")` from the official migration
table. Checking omo's own sources, **omo never implemented a `shell.env` hook**:

```
grep -rn '"shell.env"' packages/omo-opencode/src   -> only shared/shell-env.test.ts (a utility test)
grep -rn "nonInteractiveEnv" plugin/*.ts           -> plugin/tool-execute-before.ts:75
```

`non-interactive-env` (the hook that builds the env prefix and rewrites bash args) is a session-tier
hook driven by **`tool.execute.before`**, and that hook is already registered on V2
(`tool.hook("execute.before")`). So the capability is live and the V2 shell hook has no omo consumer.

Conclusion: no code change. `ctx.shell.hook("create.before")` stays on the list as available-if-needed;
if a future change wants to guard command creation before the shell is spawned (rather than rewriting
tool args), that is where it goes.
