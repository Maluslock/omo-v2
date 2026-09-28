# The TUI plugin is still V1-shaped, so the V2 sidebar cannot load (2026-09-24)

## Why

The parity plan listed a "TUI companion plugin" as the fallback for session enumeration. That path
was dropped for the enumeration work (P6-B9 reads the host store instead), but omo *does* ship a TUI
plugin for its sidebar (`src/tui.ts`, built to `dist/tui.js`, exported as `./tui`). On this machine
it never loads, because `~/.config/opencode/tui.json` points at `oh-my-openagent@latest` - the same
npm shape 2.0.11 rejects for the server plugin. The remaining question was whether wiring the local
build into `tui.json` fixes the sidebar.

## Method

Isolated XDG sandbox + temp HOME (the `opencode-qa` skill's isolation pattern), tmux pane 200x50,
`tui.json`:

```json
{ "plugin": ["file:/home/user/omo-v2"] }
```

`file:<packageDir>` is the form omo's own `ensureTuiPluginEntry` mirrors when the server plugin is a
file entry, and the repo root exports `./tui` -> `dist/tui.js`, so this is the sanctioned local
shape. Launched with `opencode --standalone <proj>` so a private server is used and the machine's
background service is never touched.

## Observed

The TUI boots and the plugin is recognised - it is listed under the **TUI** heading - but it failed:

```
Plugins                                                            esc
  Search
  TUI
x file:/home/user/omo-v2                                           failed
```

Selecting it shows the host's reason:

```
TUI plugin error
file:/home/user/omo-v2
Invalid V2 TUI plugin module: file:/home/user/omo-v2
```

The footer agrees: `⊙ 1 plugin failed /plugins`. No sidebar section renders (the idle sidebar would
show a bordered `Models` section).

## Root cause

`dist/tui.js` exports the **V1 TUI plugin module**:

```js
var module = { id: "oh-my-openagent:tui", tui: async (api) => { ... } }
```

2.0.11 requires the V2 shape, from the extracted `@opencode/plugin@2.0.11` types
(`research/pkgs/x_opencode_plugin2.0.11/package/dist/tui/plugin.d.ts`):

```ts
export interface Definition {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export declare function define(plugin: Definition): Definition
```

This is exactly the server-side `{id, server}` -> `{id, setup}` change: the adapter has a V2 port for
the server plugin (`src/v2/create-v2-plugin.ts`, `Plugin.define`) and **none for the TUI**. So the
sidebar cannot load on any 2.0.11 host, and rewriting `tui.json` to the local path does not help -
both entries fail on the module shape.

## Why the real config was left alone

`~/.config/opencode/tui.json` still reads `"plugin": ["oh-my-openagent@latest"]`. Changing it to the
local path would replace one failing entry with another failing entry, so nothing was changed outside
the workspace.

## What a port needs

The 2.0.11 TUI `Context` (same extracted types) is rich enough to host the sidebar:

| current V1 usage | V2 equivalent |
|---|---|
| `{ id, tui: async (api) => {...} }` | `Plugin.define({ id, setup: async (context) => cleanup })` |
| `api.state.path.directory` | `context.location` (`LocationRef`) |
| `api.slots.register({ order, slots: { sidebar_content } })` | `context.ui.slot({ append: "sidebar.content", render })` |
| `api.renderer.requestRender()` | reactive rendering (Solid store from `context.storage.memory`) |
| `api.theme.current` | `context.theme` |
| `api.lifecycle.onDispose(cb)` | return a `Cleanup` from `setup` |
| `await import("@opentui/solid")` + `createElement`/`setProp`/`insert` | same primitives if the host still provides them, otherwise JSX (which would need the tui build to gain a JSX source config) |

The render half is the open question: omo materializes its own `ViewNode` tree through
`@opentui/solid` dynamically, which sidesteps JSX today. Whether 2.0.11's slot `render` accepts those
same nodes, or needs real JSX plus a `script/build.ts` change, is the first thing the port has to
settle.

## Follow-up: the official 2.x docs (2026-09-24)

The live failure above only proved the module was rejected. The official docs answer the rest, and both
blockers are now precise:

- `https://opencode.ai/v2/docs/build/plugins/cli/` (CLI plugins): V2 CLI/TUI extensions are
  `import { Plugin } from "@opencode/plugin/tui"` plus `Plugin.define({ id, setup(context) })`. The host
  resolves that specifier at runtime, so a local CLI plugin needs no absolute path. `setup` receives
  `options`, `app`, `location`, `client`, `data`, `renderer`, `theme`, `ui`, `storage`, `attention` and
  `markdown`, and returns a cleanup function. Slots available include `app`, `home.footer`,
  `home.footer.status`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`,
  `session.composer.top`, `sidebar.content` and `sidebar.footer`; `render` returns JSX, with `prepend`,
  `append`, `before`, `after` or `replace` placement.
- `https://opencode.ai/v2/docs/cli/config/` (CLI settings): the terminal client owns exactly one global
  file, `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`), with
  `"$schema": "https://opencode.ai/v2/cli.json"`. Unknown settings are rejected and valid edits reload
  while the TUI runs. CLI plugins are declared under `plugins` (array; entries are a package name, a
  local path, a file URL, or `{ package, options }`), and a leading `-` disables one. There is no
  project-local CLI settings file. When `cli.json` is absent, the first V2 client start migrates
  supported global `tui.json` settings and persisted preferences, leaving V1 files unchanged.
- `@opencode/plugin@2.0.11` exports `./tui` -> `./dist/tui/index.js`, so the import resolves from the
  installed package as well.

That closes the open question in the section above: the render contract is JSX, not omo's `ViewNode`
tree, and the config half is a file-name and key change (`tui.json` `plugin` -> `cli.json` `plugins`).
omo's `ensureTuiPluginEntry` still targets `tui.json`, so a 2.x port needs both a module port and an
installer branch.

## Safety

- The tmux session was killed and confirmed gone.
- The machine's services are unchanged: PID 573362 on `127.0.0.1:49374` and PID 697268 on
  `0.0.0.0:4096` before and after, same start times.
- The sandbox used its own HOME/XDG roots, so no session was written to the real database.
- Only `/plugins` was typed into the TUI; nothing in the user's config was modified.

Captured panes: `.omo/tmp/tui-smoke/capture.txt` plus the session name in
`.omo/tmp/tui-smoke/session.txt`; sandbox `tui.json` at
`.omo/tmp/tui-smoke/xdg/config/opencode/tui.json`.
