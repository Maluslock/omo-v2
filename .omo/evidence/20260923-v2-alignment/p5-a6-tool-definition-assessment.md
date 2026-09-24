# P5-A6 `tool.definition` — assessment: no target tool on V2 (2026-09-24)

omo's only `tool.definition` hook is `todo-description-override`:

```ts
"tool.definition": async (input: { toolID: string }, output: { description: string; parameters: unknown }) => {
  if (input.toolID === "todowrite") output.description = TODOWRITE_DESCRIPTION
}
```

The official migration table sends `tool.definition` to `ctx.tool.transform(...)`, but on V2 there is
nothing to override: **the host ships no todo tool.**

Evidence:

```
grep -c in the opencode 2.0.11 binary:
  todowrite 0   TodoWrite 0   todo_write 0   todoread 0
  skill 111     glob 703      grep 61          <- controls that do exist
grep in @opencode/schema@2.0.11 + @opencode/plugin@2.0.11 dist: no match for todowrite
```

So the description override is V1-only by construction, like `task_create`/`task_update` (V2 removed
host todos). No code change; if omo's task system is re-implemented in P6-B2 on `ctx.storage`, the
description belongs to that new tool, not to a host tool transform.
