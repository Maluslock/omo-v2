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

## Safety

- The tmux session was killed and confirmed gone.
- The machine's services are unchanged: PID 573362 on `127.0.0.1:49374` and PID 697268 on
  `0.0.0.0:4096` before and after, same start times.
- The sandbox used its own HOME/XDG roots, so no session was written to the real database.
- Only `/plugins` was typed into the TUI; nothing in the user's config was modified.

Captured panes: `.omo/tmp/tui-smoke/capture.txt` plus the session name in
`.omo/tmp/tui-smoke/session.txt`; sandbox `tui.json` at
`.omo/tmp/tui-smoke/xdg/config/opencode/tui.json`.
