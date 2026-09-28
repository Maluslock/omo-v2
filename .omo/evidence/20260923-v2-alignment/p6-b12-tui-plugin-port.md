# P6-B12: the TUI sidebar plugin runs on OpenCode 2.x (2026-09-24)

## Why

`packages/omo-opencode/src/tui.ts` shipped the V1 CLI plugin module (`{ id, tui: async (api) => ... }`).
On 2.0.11 the host listed the entry and refused it (`Invalid V2 TUI plugin module`), so the sidebar
could not load. Reading the official pages made the target contract explicit:

- `https://opencode.ai/v2/docs/build/plugins/cli/`: CLI plugins are
  `import { Plugin } from "@opencode/plugin/tui"` plus `Plugin.define({ id, setup(context) })`. The
  host resolves that specifier at runtime. Slots include `sidebar.content` and `sidebar.footer`, and
  slot `render` returns JSX.
- `https://opencode.ai/v2/docs/cli/config/`: the terminal client owns one global
  `~/.config/opencode/cli.json` (`$XDG_CONFIG_HOME/opencode/cli.json`), where CLI plugins are declared
  under `plugins` (package name, local path, file URL, or `{ package, options }`). There is no
  project-local client config; when `cli.json` is absent the first 2.x client start migrates supported
  global `tui.json` settings.

`Plugin.define` is an identity function in 2.0.11 (`function define(plugin) { return plugin }`), so the
V2 definition object is built under its type without importing the helper as a value. That matters for
1.x: a type-only import keeps `@opencode/plugin/tui` and its `solid-js` dependency out of the V1
host's runtime path entirely.

## What changed

- `packages/omo-opencode/src/tui.ts`
  - The V1 module is unchanged in behavior and now lives in `v1Module`; the default export is
    `{ ...v1Module, ...createV2TuiDefinition() }`, so 1.x reads `tui` and 2.x reads `setup`.
  - `createV2TuiDefinition()` claims `context.ui.slot({ append: "sidebar.content", ... })`, derives the
    directory from `context.location?.directory ?? context.data.location.default().directory`, reads
    the theme from `context.theme`, and publishes the view through `context.storage.memory`, which is
    what makes the slot re-render (no manual `requestRender`).
  - The 1s poller was extracted into `createSidebarViewPolling`, shared by both paths; on 2.x the
    change callback writes the reactive store instead of requesting a render.
  - The render value is the same imperatively built `@opentui/solid` node the V1 path produces, cast to
    the slot's JSX type at one boundary (a typed equivalent of returning JSX, with a comment saying so).
- `packages/omo-opencode/src/shared/opencode-client-config.ts` (new): `resolveClientConfigTarget`
  picks `cli.json` + `plugins` for hosts >= 2.0.0 and `tui.json` + `plugin` otherwise. It lives in
  `shared/` because both the installer and the doctor need it; putting it in either of those would
  create an import cycle. It takes an optional `hostVersion`, so a caller that already resolved the
  version pins the decision instead of re-detecting it.
- `cli/config-manager/add-tui-plugin-to-tui-config.ts`: `ensureTuiPluginEntry` writes the target file
  and key for the host, adds `"$schema": "https://opencode.ai/v2/cli.json"` when it creates `cli.json`,
  and preserves unrelated settings. The installers pass the host version they already resolved.
- `cli/doctor/checks/tui-plugin-config.ts`: detection inspects the host's client config instead of
  `tui.json` only, and the user-facing messages name the file actually inspected.

## Live verification (isolated sandbox, tmux)

Sandbox: fresh `HOME`/`XDG_*` roots under `.omo/tmp/tui-smoke`, project plugin directory pointing at
the locally built `dist/index.js`, and a 2.x client config:

```json
{ "$schema": "https://opencode.ai/v2/cli.json", "plugins": ["file:/home/user/omo-v2"] }
```

`opencode --standalone <proj>` inside a 200x50 tmux pane.

**Before the port** (V1 module, same `file:` entry):

```
Plugins
  TUI
x file:/home/user/omo-v2                failed
  -> TUI plugin error: Invalid V2 TUI plugin module: file:/home/user/omo-v2
footer: ⊙ 1 plugin failed /plugins
```

**After the port**:

```
Plugins
  TUI
  oh-my-openagent:tui                   (no failure marker; `enter` opens it)
footer: (no plugin-failed indicator)
```

and the sidebar itself renders once a session is open (the home screen does not mount
`sidebar.content`):

```
┌───────────────────────────────────┐
│ Models                            │
│ artistry deepseek-flash           │
│ atlas kimi-k2.6                   │
│ deep deepseek-flash               │
│ explore deepseek-flash            │
│ hephaestus kimi-k2.7-code         │
│ librarian deepseek-flash          │
│ metis deepseek-flash              │
│ momus deepseek-flash              │
│ multimodal-looker kimi-k2.7-code  │
└───────────────────────────────────┘
```

Captures: `.omo/tmp/tui-smoke/capture.txt` (before), `capture-session.txt` (after, session view).
The tmux session was killed and the machine's services were unchanged (PID/ports verified).

## Tests

```
bun test packages/omo-opencode/src/tui.test.ts                                                 6 pass
bun test packages/omo-opencode/src/cli/config-manager/add-tui-plugin-to-tui-config.test.ts    10 pass
bun test packages/omo-opencode/src/cli/doctor/checks/tui-plugin-config*.test.ts               15 pass
bun test packages/omo-opencode/src/testing/create-plugin-module.test.ts                       15 pass
```

Two defects the new tests caught:

1. `pluginEntries()` read the `plugin` key unconditionally, so on a 2.x `cli.json` the idempotency
   check never saw the existing entry and appended a duplicate on every install. It now takes the
   target's key.
2. The installer tests already mocked `getOpenCodeVersion`, but the new branch resolved the version
   through the `shared` helper and ignored that mock. The host version is now injected into
   `ensureTuiPluginEntry`, so the mocks mean what they say.

## Two test-hygiene lessons from getting the suite green

The first full run after the port showed 7 extra failures, and the second still showed 4. Both were
self-inflicted state leakage, not product bugs:

- **The version cache is process-global.** My new tests pinned it with `setVersionCache(...)` and then
  called `resetVersionCache()`, which wiped whatever value the suites around them had inherited. They
  now capture `getOpenCodeVersion()` first and restore it, so the inherited state round-trips.
- **Never `mock.module` a shared config module from a sidebar test.** One case mocked
  `./config/validate`; because `roster-resolver` and others import the same module, the mock leaked
  across files and made four unrelated tests fail only in a full run. That case now writes a real
  `.omo/omo.jsonc` inside an isolated `HOME`/`OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME`, the same
  technique the neighbour suite uses. The tell: every leaked failure passed in isolation.

## Regression check

Full `bun test` on a quiet machine: **12952 pass / 3 skip / 13 fail** - the known pre-existing
failures only. `tsgo --noEmit` exits 0, and `dist/` was rebuilt so the artifact matches the source.

One flake to be aware of: on a loaded machine the
`prompt-async-route-audit.test.ts` source scan can exceed its 5s budget, which then cascades into a
`Connection is closed` error from `typescript-native-source-parser.ts`. It passes alone in 5.3s and
passes in the full suite on a quiet machine; it is not related to this change.

## Why this is enough

- The failure was reproduced first (host error plus `1 plugin failed`) and is gone in the same sandbox
  with the same config entry, which ties the fix to the observed defect.
- The sidebar's actual content is visible in the capture, so the proof covers the render contract
  (JSX-typed slot), the reactive store and the theme, not just "module accepted".
- The installer and doctor halves have unit tests on both host generations, including the idempotency
  case that caught the key bug.

## What was omitted

Synthetic content only; no real session text or credentials. The 1.x path is unchanged but has no live
1.x host here, so its evidence stays the existing unit suite.

## Residual risk

- The slot render uses an imperatively built `@opentui/solid` node cast to the JSX type. It renders on
  2.0.11; a host that tightens the slot contract to real JSX elements would need a JSX build config
  for `src/tui.ts`.
- The installer and the startup self-heal depend on version detection; an undetectable host takes the
  2.x path, which is documented at the resolver.
- The sidebar still reads the server-written mirror for jobs/agents, and that mirror write is failing
  in this sandbox (`[tui-sidebar] mirror flush failed`, pre-existing and unrelated to this port).
