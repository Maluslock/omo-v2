# P5-A3 `permission` + the `skill` tool — assessment: no code change (2026-09-24)

The parity plan listed "`permission.hook("evaluate")` -> re-enable omo's `skill` tool". Reading the
actual call sites changes the conclusion.

## `ask` is optional everywhere, so nothing is blocked

```
tools/skill/tools.ts:153        await ctx?.ask({ permission: "skill", patterns: [matchedSkill.name], ... })
tools/monitor/monitor-start.ts:103   ...(ctx.ask ? { bashPermissionAsk: ctx.ask } : {})
features/monitor/permission.ts       wraps ctx.ask({ permission: "bash", ... }) for the monitor tools
```

`ctx?.ask(...)` is a no-op when the V2 tool context has no `ask`, and the monitor site is explicitly
conditional. So the V2 `skill` tool would run; it simply would not prompt. The earlier note that the
tool was "blocked by the ask gap (fail-closed)" described the *gating decision*, not a crash.

## Why it is still not worth registering

The V2 host ships its own `skill` tool and it loads omo-registered skills - verified live in the
provider sandbox (`→ Skill "git-master"` then `SKILL_OK`, with omo's 20 skills registered). omo tools
are namespaced, so registering omo's would add a second skill tool (`omo_skill`) rather than shadow
the host's, and the two would differ:

| capability | host `skill` | omo `skill` |
|---|---|---|
| load a registered skill by name | yes | yes |
| execute a slash command through the skill tool | no | yes (`getCommands()`) |
| hide/enforce `definition.agent`-restricted skills | no | yes |
| permission prompt before loading | yes (host permission flow) | `ctx?.ask`, which is a no-op on V2 |
| inject git-master config, compute base directory | no | yes |

Registering it would add a duplicate capability while bypassing the host's permission flow for the
same action. The two real deltas (command execution, agent-restricted visibility) are recorded in the
parity plan instead of being implemented as a second tool.

## Consequence for `permission.hook("evaluate")`

There is no consumer for it in the current port: every `ask` site is optional, and the only tool that
needs a bash permission ask (`monitor_*`) is not registered on V2. Implementing the hook now would be
speculative code with no caller. It stays on the list as the mechanism to use **if** an ask-gated
tool is ported (the monitor rewrite in P6-B3 is the likely first caller).

## What is still true

- Only one tool remains unregistered: `skill` (registration line `{"registered":13,"skipped":1,
  "skippedTools":["skill"]}`).
- The capability itself is available to the model through the host's tool, so the user-visible gap is
  the two deltas above, not skill loading.
