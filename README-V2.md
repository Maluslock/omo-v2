# oh-my-openagent on OpenCode V2

A fork of [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) that loads on
the OpenCode **2.x plugin API**. Verified against `opencode` 2.0.11.

> [!NOTE]
> This is a port fork, not the upstream project. Upstream is the source of truth for features,
> agents, hooks and user documentation; this README covers only what changed so the plugin runs on
> OpenCode 2.x, plus the upstream bugs fixed along the way. The package is **not published to npm**
> from this fork.

## Why this fork exists

OpenCode 2.x replaced the V1 plugin contract (`{ id, server }`) with `Plugin.define({ id, setup })`.
The published package still exports the V1 shape, so 2.x refuses to load it:

```
WARN failed to load plugin target=oh-my-openagent@latest
     PluginModule.LoadError: Plugin must export a default definition with an id and an effect or
     setup function. (cause: Missing key at ["default"]["setup"])
```

This fork exports **both** shapes from one default export, so the same package loads on 1.x and 2.x:

```ts
// packages/omo-opencode/src/index.ts
export default {
  ...pluginModule,        // { id, server }  -> OpenCode 1.x
  ...createV2Plugin(),    // { id, setup }   -> OpenCode 2.x
}
```

Everything behind that boundary (agents, the full V1 hook composition, tool factories, MCPs, skills,
`team-core`, `model-core`) is the unchanged upstream code.

## What works on OpenCode 2.x

With a real user configuration on 2.0.11:

```
agents   12   (default: Sisyphus - ultraworker)
tools    13 registered / 1 skipped (skill, the host ships its own)
hooks    12 registrations fanning out to the full V1 tier composition
mcps     5    (lsp serves 8 LSP tools)
commands 16
skills   20
```

| Capability | V2 mechanism | State |
|---|---|---|
| Agents, tools, hooks, MCPs, commands, skills | the matching `ctx.<domain>.transform` | ported |
| `chat.message`, `chat.params`, `chat.headers` | `session.hook("prompt" / "context" / "model.request")` | ported |
| Message and system transforms | `session.hook("context").messages` / `.system` | ported |
| Compaction | `session.hook("compaction")` + `session.compaction.ended` state restore | ported |
| Lifecycle events | `ctx.event.subscribe` with a corrected V1 event vocabulary | ported |
| Session list / search / info | omo's own index in `ctx.storage` + read-only host-store backfill | ported |
| Task tools, monitor tools, team tools (12), goal tools | existing V1 bodies behind the rebuilt V1 client surface | ported |
| TUI sidebar plugin | needs the V2 CLI plugin shape | **not ported yet** |

The full matrix, the per-capability evidence and the measured host facts are in
[docs/reference/v2-port-summary.md](docs/reference/v2-port-summary.md). If you are changing the
adapter, read [docs/reference/v2-plugin-adapter.md](docs/reference/v2-plugin-adapter.md).

## Install today (local build)

There is no npm package from this fork yet, so install from source:

```bash
git clone <this fork>
cd <this fork>
OMO_SKIP_MATERIALIZE=1 bun run build
```

Then point your OpenCode plugin directory at the built bundle:

```ts
// <project>/.opencode/plugins/omo-local.ts   (or ~/.config/opencode/plugins/omo-local.ts)
export { default } from "<absolute path to the fork>/dist/index.js"
```

Notes that save time:

- `OMO_SKIP_MATERIALIZE=1` is required in this checkout: the bare build runs
  `git submodule update --init` for `packages/shared-skills/upstreams/*`, which are declared in
  `.gitmodules` but have no gitlinks in the index.
- A local path inside the `plugins` array of `opencode.json` does not load on 2.0.11. A file in the
  plugin **directory** does.
- Build output also rewrites `packages/omo-codex/scripts/install-dist/install-local.mjs`; revert that
  file if you are not touching the Codex side.

## OpenCode 2.x notes

- **Terminal client config moved.** V2 replaced the layered `tui.json(c)` with one global
  `~/.config/opencode/cli.json` (`$XDG_CONFIG_HOME/opencode/cli.json`), which the terminal client
  owns; the background service does not read it. CLI plugins are declared there under `plugins`
  (entries may be a package name, a local path, or a file URL, optionally with `options`). Unknown
  settings are rejected. When `cli.json` is absent, the first 2.x client start migrates supported
  global `tui.json` settings.
- **Session enumeration.** 2.x gives server plugins no way to list sessions, so omo keeps its own
  index and additionally reads the host's own SQLite store (`opencode.db`, table `session_v2`)
  read-only to cover sessions created before the plugin loaded. The read is fail-soft, and
  `OMO_SESSION_DB_PATH` points it at a non-standard location.
- **Permissions fail closed.** 2.x `ToolContext` has no `ask`, so permission-gated code answers from
  its own allowlist (`monitor.allowed_commands`) and rejects everything else with an explicit error.
- **Reasoning levels.** A model that declares variants receives the variant, applied at request time.
  Models with no declared variants fall back to a reasoning effort, which the host drops for unknown
  model families. This is upstream compatibility behavior, not a fork change.
- **TUI sidebar is not ported yet.** The shipped `dist/tui.js` still exports the V1 shape
  (`{ id, tui(api) }`) and 2.x wants `Plugin.define({ id, setup(context) })` from
  `@opencode/plugin/tui`, declared in `cli.json`. On 2.0.11 the host reports
  `Invalid V2 TUI plugin module`. Everything else in this table works without it.
- **npm publishing** is not done here. Upstream publishes through its release workflow.

## Differences from upstream

Besides the V2 adapter, this fork carries four fixes for bugs that exist upstream on 1.x as well:

| Fix | Upstream effect |
|---|---|
| `disabled_commands: ["handoff"]` no longer drops the whole array (one unknown enum member made Zod discard it) | the key silently did nothing |
| Category `max_tokens` is read (only the deprecated `maxTokens` was) | the documented key was ignored |
| Task writes await the file lock (`acquireLockAsync`) | parallel `task_create` failed with `task_lock_unavailable` |
| The `task-reminder` hook is composed (it had tests but was in no tier) | the reminder never fired |

## Development

```bash
bun test                 # full suite; the known baseline is 3 skipped and 13 pre-existing failures
npx tsgo --noEmit        # type gate
OMO_SKIP_MATERIALIZE=1 bun run build
```

Adapter code lives in `packages/omo-opencode/src/v2/`. Read
[docs/reference/v2-plugin-adapter.md](docs/reference/v2-plugin-adapter.md) before touching it: it
documents the bridge patterns, the host facts the design depends on, the repository gates that will
catch mistakes (arg-schema provenance, the Bun runtime audit, the markdown link audit) and the
isolated probe recipe used for every live verification.

Live verification in this fork never points at a real store: probes use a copied config, sandbox
`XDG_*` roots, the local `dist/index.js` and `opencode run --standalone`.

## Distribution and licensing

- **License: SUL-1.0** (`LICENSE.md`), the same as upstream. It grants use, modification and
  distribution **for internal business use or non-commercial/personal use**, and distribution is
  allowed only if it is free of charge for non-commercial purposes. Licensing and copyright notices
  must stay intact, and upstream trademarks are not granted. If you publish this fork, keep
  `LICENSE.md` and `THIRD-PARTY-NOTICES.md` and do not present it as the upstream project.
- **Not on npm.** The safe ways to share this fork are a GitHub release carrying the built `dist/`
  plus these install steps, or pushing the branch and letting people build locally.
- **Upstream PRs** must follow upstream's rules: target the `dev` branch, merge commits only, CI
  green (including the Codex compatibility gate), no `as any`.

## Credits

Upstream project, architecture and features: [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent).
The V2 plugin API this fork targets is documented at
[opencode.ai/v2/docs](https://opencode.ai/v2/docs/) (see Build, plugins, CLI plugins).
