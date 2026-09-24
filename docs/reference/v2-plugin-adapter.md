# OpenCode V2 plugin adapter - development guide

**Generated:** 2026-09-24 | **Host version referenced:** `opencode` 2.0.11

omo ships one plugin bundle that has to load on two different hosts:

- OpenCode 1.x, which calls `server(input, options)` and hands the plugin a full `client`.
- OpenCode 2.x, which reads `id` + `setup(ctx)` from `Plugin.define` and exposes domain APIs
  (`ctx.session`, `ctx.tool`, `ctx.event`, ...) instead of a client.

All of the V2-specific boundary code lives in
[`packages/omo-opencode/src/v2/`](../../packages/omo-opencode/src/v2/). Everything behind it (the
agents, the ~55 hooks, the tool factories, `team-core`, `model-core`, ...) is the unchanged V1 code.
This is the guide for changing that boundary.

## 1. Entry point and boot flow

[`packages/omo-opencode/src/index.ts`](../../packages/omo-opencode/src/index.ts) spreads both shapes
into one default export:

```ts
export default {
  ...pluginModule,        // { id, server }  -> used by 1.x
  ...createV2Plugin(),    // { id, setup }   -> used by 2.x
}
```

V2 ignores `server`; 1.x ignores `setup`. `createV2Plugin`
([`v2/create-v2-plugin.ts`](../../packages/omo-opencode/src/v2/create-v2-plugin.ts)) runs the
registration passes in this order and swallows any failure:

```
setup(ctx)
  loadPluginConfig(ctx.location.directory, ctx)
  registerOmoAgents          # ctx.agent.transform
  registerOmoTools           # ctx.tool.transform (+ ctx.tool.hook for execute.before/after)
  registerOmoHooks           # session/tool/system/compaction hooks + the event stream
  registerOmoMcps            # ctx.mcp.transform
  registerOmoCommands        # ctx.command.transform
  registerOmoSkills          # ctx.skill.transform
  registerOmoSessionIndex    # ctx.storage + ctx.event.subscribe feed
```

**Loadability contract (P0):** a config-load or assembly failure is logged and swallowed, because a
plugin that throws inside `setup` makes the whole host unusable. Keep that property when adding a
registration pass: fail soft, log once, and leave the rest of the surface intact.

`setup` runs again on reload, so every registration is idempotent (add when `editor.get(id)` is
absent, otherwise `editor.update`).

## 2. Module map

| Module | Responsibility |
|---|---|
| `create-v2-plugin.ts` | `Plugin.define` entrypoint and the registration order. |
| `register-agents.ts` | Agent transform. Merges permission rulesets instead of replacing the host defaults. |
| `register-tools.ts` | Tool registry into `ctx.tool.transform`; owns `CLIENT_DEPENDENT_TOOLS` / `SHIM_UNLOCKED_TOOLS` and the per-location task list id. |
| `register-hooks.ts` | Per-domain hook registration (`registerOmo*Hooks`). |
| `register-hook-assembly.ts` | Assembles the V1 hook tiers and registers the mapped ones; owns the event subscription. |
| `register-mcps.ts` | Built-in MCP servers into `ctx.mcp.transform`. |
| `register-commands.ts` + `command-mapping.ts` + `command-delivery.ts` | Slash commands: V2 commands cannot inject host-expanded templates, so the plugin registers commands whose `execute` posts the expanded prompt itself (through the prompt gate). |
| `register-skills.ts` + `skill-mapping.ts` | Registers only the skills the host cannot discover (builtins, runtime source), leaving disk skills to the host. |
| `register-session-index.ts` + `session-index.ts` | omo's own session index in `ctx.storage`, fed by the `prompt` hook and the event stream. |
| `client-shim.ts` + `client-shim-messages.ts` | Rebuilds the V1 `client` surface from V2 domains for code that captured `client` at construction. |
| `tool-mapping.ts` | `toV2Tool`: arg-schema provenance check, zod-override stripping, V1 `ToolContext` reconstruction. |
| `tool-hook-mapping.ts` | `tool.execute.before/after` event adapters. |
| `hook-mapping.ts` | V2 event envelope to V1 `{event: {type, properties}}`, including the turn-end mapping. |
| `event-subscription.ts` | Drives the V1 `event` handlers from `ctx.event.subscribe`, with bounded teardown. |
| `prompt-hook-mapping.ts` | `session.hook("prompt")` to V1 `chat.message`. |
| `model-request-hook-mapping.ts` | `session.hook("context")` to V1 `chat.params` (generation options + variant). |
| `request-message-mapping.ts` | `session.hook("context").messages` to V1 `experimental.chat.messages.transform`. |
| `system-hook-mapping.ts` | `session.hook("context").system` to V1 `experimental.chat.system.transform`. |
| `compaction-hook-mapping.ts` | `session.hook("compaction")` to V1 `experimental.session.compacting`. |
| `compaction-end-restore.ts` | V1's `compaction.autocontinue` state restore, driven by `session.compaction.ended`. |
| `chat-headers-mapping.ts` | V1 `chat.headers` on `session.hook("model.request")`, primary requests only. |
| `agent-mapping.ts` | Agent model/variant and permission-rule mapping. |
| `mcp-mapping.ts` | V1 MCP server shape to V2 server config. |
| `session-activity.ts` | Rebuilds `client.session.status` from the turn envelope so the background manager does not treat live subagents as gone. |
| `ask-resolver.ts` | Answers the one `ctx.ask` site (`monitor`) from `monitor.allowed_commands`; everything else fails closed. |

## 3. The three bridge patterns

### 3.1 Handlers are (input, output) pairs, events are single mutables

Every `registerOmo*Hooks` function adapts one V2 event into the V1 pair and then writes the result
back. Two rules matter:

- **Only mutate what the host actually carries.** `toV1ChatParams` synthesizes the `message` record
  the V1 handler requires (see 4.5); `prompt-hook-mapping.ts` reports fields with no V2 home through
  `onUnmapped` rather than dropping them silently.
- **Keep the V1 names in the V1 view.** V1 `maxOutputTokens` maps to V2 `maxTokens` on the way out and
  is seeded back on the way in, because omo's own handlers read and write the V1 name.

### 3.2 The one host-facing choke point for prompts

Commands, monitor output, team live delivery and continuation all reach a session through
`dispatchInternalPrompt` in
[`shared/prompt-async-gate.ts`](../../packages/omo-opencode/src/shared/prompt-async-gate.ts). The
gate feature-detects `session.prompt` on the shim, so on a V2 host without it those paths fail closed
instead of throwing. The static
[`prompt-async-route-audit.test.ts`](../../packages/omo-opencode/src/shared/prompt-async-route-audit.test.ts)
fails the suite if a raw `session.promptAsync` appears outside the gate. Do not add one.

### 3.3 The client shim and its two seams

Tools and managers were written against `ctx.client`. `createV1ClientShim` rebuilds the subset they
use, and two seams plug host-specific behavior into pre-existing extension points:

- `setSessionIndexSource` ([`tools/session-manager/storage.ts`](../../packages/omo-opencode/src/tools/session-manager/storage.ts))
  replaces SDK session enumeration with omo's index. It is installed only while at least one index
  exists, so a host without one keeps the original SDK/file behavior.
- `session-activity.ts` is read by the shim's `session.status`; it is fed from the session index's
  event subscription rather than opening another stream.

## 4. Measured host facts the design depends on

Each row was measured on a live 2.0.11 host. The evidence files live under
`../../.omo/evidence/20260923-v2-alignment/` (force-added to git because `.omo/*` is ignored).

| Fact | Why it matters | Evidence |
|---|---|---|
| `ctx.session` is a `Pick` without `list`, and `ctx.rpc` has no callable host proxy | Server plugins cannot enumerate sessions; the index exists because of this | `p6-b9-session-backfill.md`, `research/REPORT.md` |
| The host's own store is `<data dir>/opencode/opencode.db`, table `session_v2` | Session backfill reads it read-only; WAL rows are visible to a `readonly` connection | `p6-b9-session-backfill.md` |
| V2 emits no `session.idle`, no `session.status`, no `session.compacted` | The turn end is `session.execution.succeeded`; mapping it is what makes every idle-keyed hook fire | `live-v2-event-catalog.md` |
| `session.compaction.started` / `.ended` exist; a mid-turn turn continues after compaction | omo only restores its own state and must not inject a continuation prompt | `p6-b7-mid-turn-compaction.md` |
| `context.options` is a typed surface (`maxTokens`, `temperature`, `topP`, `topK`, ... ) and unknown keys are dropped | V1 names must be translated, not passed through | `p6-b10-reasoning-effort-channel.md` |
| Typed `reasoningEffort` is lowered to the provider's `reasoning_effort`; the snake spelling is dropped | The V1 effort fallback needs no special handling | `p6-b10-reasoning-effort-channel.md` |
| Writing `event.model.variant` inside `context` is honored by the primary request | The request-time variant lowering works without a mutable message | `p6-b6-chat-params-bridge.md` |
| `ToolContext` has no `ask`, and `permission.hook("evaluate")` cannot create a request | Permission-gated code must answer the ask itself and fail closed | `p5-a3-permission-assessment.md`, `p6-b3-monitor.md` |
| `ctx.storage` is a plugin-namespaced KV that survives restarts | The session index persists | `live-v2-storage-events.md` |
| The host context is a Bun single-file executable | `bun:sqlite` is available, but only through a `bun-*-shim.ts` | `p6-b9-session-backfill.md` |
| A TUI plugin must be `Plugin.define({id, setup})`; the shipped `dist/tui.js` is still V1-shaped | The sidebar cannot load on 2.0.11 | `p6-b11-tui-plugin-v1-shape.md` |

## 5. Recipes

### Unblock a denylisted tool

1. Read the tool's factory and list every host surface it dereferences. Ten of the twelve `team_*`
   factories took `client` and never read it, so "needs a client" was never true.
2. If the shim can serve it, move the name from `CLIENT_DEPENDENT_TOOLS` to `SHIM_UNLOCKED_TOOLS` in
   `register-tools.ts` and extend `register-tools.test.ts`.
3. Prove it live. A registered tool that throws on every call is worse than an absent one.

### Add a tool

Tools are registered by name from the existing V1 registry; there is no separate V2 tool factory. The
only V2-specific requirements are that `args` are built with `tool.schema` (see 6.1) and that the
`execute` signature stays `(args, context)`.

### Map another V1 hook

1. Add the mapping to the matching `*-mapping.ts` module, or create one if the domain is new.
2. Register it in `register-hooks.ts` and add it to `register-hook-assembly.ts` if it belongs to the
   assembled tiers.
3. Write the adapter test (V2 event in, V1 output mutations out) and, if the hook has side effects,
   prove it on the isolated host.

### Add an event mapping

`hook-mapping.ts` holds the V2 to V1 event table and the property builder. Add the entry, extend
`hook-mapping.test.ts`, and confirm the event actually fires on a live host before relying on it.
`session.idle` was in that table for months while the host never emitted it.

## 6. What will catch you (repo gates)

### 6.1 Arg-schema provenance

V2 walks a tool's input schema with its own converter. `def.args` come from
`@opencode-ai/plugin`'s bundled zod while `toV2Tool` uses this package's zod, so a wrapper built with
the wrong instance is silently dropped by the host. `toV2Tool` throws `ArgSchemaProvenanceError`
instead, and `stripForeignJsonSchemaOverride` removes the delegating `toJSONSchema` override that V1
needs. Do not hand-roll a tool schema.

### 6.2 Bun runtime audit

`opencode-adapter-bun-runtime-audit.test.ts` forbids `Bun.<api>` and `bun:*` imports in adapter source
except in `bun-*-shim.ts` files. Put runtime access in the shim, never loosen the audit.

### 6.3 Markdown link audit

`markdown-link-audit.test.ts` fails on machine-local absolute paths (any home-directory absolute path,
and `file://` URLs pointing at one) and on local links whose target does not exist. Use relative links
and `~` paths.

## 7. Local development and verification

### Build

```bash
OMO_SKIP_MATERIALIZE=1 bun run build
```

The bare `bun run build` fails in `git submodule update --init` because `.gitmodules` declares
`packages/shared-skills/upstreams/*` while the index has no gitlinks. `OMO_SKIP_MATERIALIZE=1` is the
repo's supported path. The build also rewrites
`packages/omo-codex/scripts/install-dist/install-local.mjs`; revert that file after a build if you are
not touching the Codex side.

### Load the local build

A local path inside the `plugins` array of `opencode.json` does not load on 2.0.11. The working shape
is a file in the plugin directory:

```ts
// <project>/.opencode/plugins/omo-local.ts
export { default } from "<repo>/dist/index.js"
```

TUI plugins are separate: `tui.json` takes the same entry list as the server config, but the shipped
`dist/tui.js` is still V1-shaped and 2.0.11 rejects it with `Invalid V2 TUI plugin module`.

### Isolated probe recipe

Never point a probe at the real store. The pattern used throughout this work:

```bash
R=<repo>/.omo/tmp/<probe>
mkdir -p "$R/proj/.opencode/plugins" "$R/xdg/data" "$R/xdg/state" "$R/xdg/cache" "$R/proj/.omo"
cp -r <real config dir> "$R/xdg/config"          # then strip the `plugins` array
echo 'export { default } from "<repo>/dist/index.js"' > "$R/proj/.opencode/plugins/omo-local.ts"
cd "$R/proj" && XDG_DATA_HOME=$R/xdg/data XDG_CONFIG_HOME=$R/xdg/config \
  XDG_STATE_HOME=$R/xdg/state XDG_CACHE_HOME=$R/xdg/cache \
  OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
  opencode run --standalone --format json --model <provider/model> "<prompt>"
```

Lessons that cost time to learn:

- Plugin loading is lazy. A bare `POST /api/session` does not load plugins; a prompt or command does.
- Measure the plugin log by line delta: unit tests write to the same log file.
- `session.status` used to be an empty stub, so live probes with subagents needed the activity
  tracker before they behaved.
- A WAL database copied without its `-wal` file loses rows. Copy the `.db`, `-db-wal` and `-db-shm`
  together when snapshotting a sandbox store.

### Test-harness knobs

- `test-setup.ts` points `HOME`/`USERPROFILE` at a hermetic temp dir, and now also
  `OMO_SESSION_DB_PATH`, because the session reader resolves through `os.homedir()`.
- `setStorageClient`, `resetSessionIndexSource`, `resetStorageClient` and
  `resetSqliteSessionBackfillWarning` are the per-suite seams.

## 8. Known gaps

| Gap | State |
|---|---|
| TUI sidebar plugin | Still V1-shaped; 2.0.11 refuses it. See `p6-b11-tui-plugin-v1-shape.md` for the API mapping a port needs. |
| Session title in tool output | `session_list` and `session_info` do not print a session title. Pre-existing formatter behavior. |
| `reasoningEffort` for unknown model families | omo's shared capability guard drops the effort on purpose; identical on V1. |
| Mid-turn compaction continuation | Host-native, verified; nothing to implement. |
| npm publishing | Out of scope for this fork; publishing goes through the release workflow. |
