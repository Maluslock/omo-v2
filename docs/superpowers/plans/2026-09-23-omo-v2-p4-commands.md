# omo V2 P4-a — port the built-in slash commands to `ctx.command.transform`

Status: done and live-verified (2026-09-23); evidence
`.omo/evidence/20260923-v2-alignment/live-command-audit.md` (`pass=22 fail=0`)
Predecessor: `2026-09-23-omo-v2-p3-hooks.md`; MCP piece landed as `3d86321`.

## Goal

V2 never calls a plugin's `config` hook, so `applyCommandConfig` (V1 phase 6) never runs and omo's
built-in slash commands (`/goal`, `/refactor`, `/start-work`, `/stop-continuation`, `/remove-ai-slops`,
`/handoff`, `/hyperplan`) do not exist on V2. V2 exposes
`ctx.command.transform((editor) => editor.add({ name, description, execute }))`, so they can be
re-contributed.

## Verified V2 command contract (live probe, isolated server on port 14321)

Probe: `/tmp/ocmd-probe/proj/.opencode/plugins/zz-cmd.ts`, driven by
`POST /api/session/{id}/command {name, text}`.

Observed:

```
[execute] {"sessionID":"ses_...","prompt":{"text":"AGENTPROBE"},"delivery":"steer"}
[before] agent="build"
[switch] ok undefined
[after] agent="plan"
[prompt] ok {"type":"user","payload":{"text":"AGENTPROBE"},"delivery":"steer"}
```

Facts established, each of which the port depends on:

1. `ctx.command.transform` exists; its editor exposes exactly `add`.
2. A registered definition is invocable through the session command API (`HTTP 204`).
3. `execute` receives `{ sessionID, prompt: PromptInput.Prompt, delivery: "steer" | "queue" }`.
4. The plugin owns delivery: `ctx.session.prompt({ sessionID, text })` posts the user message.
5. Agent routing works through `ctx.session.switchAgent({ sessionID, agent })`
   (`get` before/after shows `build` -> `plan`).
6. `opencode run "/cmd args"` does **not** resolve slash commands (it sends them as plain text), so
   command QA must drive the session command API, not `opencode run`.

## Design

1. `src/v2/command-mapping.ts`
   - `expandCommandTemplate(template, { arguments, sessionID, timestamp })` substituting
     `$ARGUMENTS`, `$SESSION_ID`, `$TIMESTAMP` (the placeholders the V1 host expanded; `$BASE_BRANCH`
     in the remove-ai-slops template is a shell variable inside a bash snippet, NOT a placeholder).
   - `toV2CommandDefinitions(commands, deliver)` mapping V1
     `{name, description?, template, agent?}` onto V2 `{name, description?, execute}`.
     V1-only fields (`argumentHint`, `model`, `subtask`, `handoffs`) have no V2 equivalent and are
     dropped, documented in the module docblock.
   - `deliver` is injected, so the mapping stays free of host types and unit-testable.
2. `src/v2/register-commands.ts`
   - `registerOmoCommands(ctx, pluginConfig, deps)`: builds the V1 command record with
     `loadBuiltinCommands(disabled_commands, { useRegisteredAgents: true, teamModeEnabled })`
     exactly like `applyCommandConfig`, then adds each to the editor. Memoized by
     `omoRuntimeKeyFor`, mirroring the other registrars.
   - The `deliver` implementation: `switchAgent` when the definition declares an agent, then
     `ctx.session.prompt({ sessionID, text, files, skills, delivery })`.
3. Wire into `createV2Plugin().setup` after `registerOmoMcps`.
4. Add `src/v2/register-commands.ts` to `RAW_PROMPT_ALLOWLIST` in
   `shared/prompt-async-route-audit.test.ts`.

### Why the audit allowlist entry is correct, not a workaround

`isSessionAccessExpression` matches any `X.session.prompt`, so the new dispatcher is flagged. The
shared gate exists to stop omo from *injecting internal messages* into a live session and to collapse
duplicate internal wakes. A command invocation is the opposite: the user typed the command, the host
handed us the invocation, and the host's own `delivery` ("steer" vs "queue") carries the concurrency
decision, which the port forwards verbatim. Routing it through `dispatchInternalPrompt` would let the
gate *drop a user's own command*. The entry's justification text records this.

## Verification plan

- Unit: `command-mapping.test.ts` (expansion, agent routing, dropped V1-only fields, malformed
  input), `register-commands.test.ts` (adds every enabled command, honours `disabled_commands`,
  memoization, delivers once per invocation, skips a missing `ctx.command`).
- Live: isolated `opencode serve` (own XDG dirs, `OPENCODE_SERVER_PASSWORD`), plus the omo dist
  loaded from `/home/user/omo-v2/dist/index.js`; create a session and POST each command name; assert
  the delivered user message is the expanded template and that `/start-work` switched the agent.
- Meta: `bun test packages/omo-opencode/src/v2/`, `prompt-async-route-audit.test.ts`, `tsgo`.
- Evidence: `.omo/evidence/20260923-v2-alignment/live-command-audit.md` + raw logs.

## Open question the live run must answer

V1's `resolveStartWorkAgent({ useRegisteredAgents: true })` returns `atlas` only if
`isAgentRegistered("atlas")` is true. That set is written by the V1 config pipeline
(`agent-config-finalizer.ts`), which V2 never runs. If the live run shows `/start-work` selecting
`sisyphus`, the V2 agent registrar must mirror the registration
(`registerAgentName` per registered agent id) and that becomes part of this change.

**Answered**: no mirroring is needed. `registerOmoAgents` calls `applyAgentConfig`, which routes
through `finalizeAgentConfig` -> `clearRegisteredAgentNames()` + `registerAgentName(...)`, so the
registry is populated on V2 as well. The live run picked `atlas`.

## Outcome

- `registered:5` with two commands disabled; disabled and unknown names answer 404; every enabled
  command answers 204 and delivers its expanded template; `/start-work` selects atlas and carries
  the expanded session id and user arguments. Full assertion log: 22 pass / 0 fail.
- Three defects surfaced and were fixed on the way:
  1. the client shim had no `tui`, so the first `client.tui.showToast` in a hook chain threw
     synchronously and every command 500'd (`command execution failed ... 'tui2.showToast'`);
  2. `BuiltinCommandNameSchema` was missing `handoff`, and one unknown entry makes Zod drop the
     whole `disabled_commands` array — a V1 defect, fixed with a drift test and regenerated schemas;
  3. `switchAgent` with the config key `atlas` is accepted and then fails inside the session runner
     (`Session.AgentNotFoundError`), dropping the prompt while still answering 204; delivery now
     resolves the key to the registered display id.
- Deliberately not ported: `init-deep` is a skill, not one of these commands, and the V1
  `command.execute.before` interception (auto-slash-command / start-work detection) remains a
  separate gap documented in the hook findings.

## Delivery note

No PR is possible in this checkout: the only remote is `code-yeongyu/oh-my-openagent` (push would
need credentials this session must not use) and `gh` is not installed. Work therefore lands as
direct commits on the local `master`, matching every commit made in this session so far.
