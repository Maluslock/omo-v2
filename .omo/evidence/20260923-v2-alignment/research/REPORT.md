# OpenCode V2 plugin API: can a plugin enumerate sessions? (research report)

**Date of research:** 2026-09-24 (UTC)
**Question owner:** port of `oh-my-opencode` to OpenCode V2 plugin API
**Installed baseline:** `@opencode/plugin@2.0.11` (confirmed locally, see "How to verify locally")
**Method:** npm registry metadata + unpacked published tarballs + `raw.githubusercontent.com` source + `api.github.com` PR/issue metadata + official docs (`opencode.ai/v2`). Artifacts saved beside this file in `pkgs/`, `upstream/`, `pr43556.diff`, `pr46690.diff`, `tree_v2.json`.

---

## Bottom line

- **Server plugins** (`@opencode/plugin`, the main `Plugin.define({ setup(ctx) })` entry; loaded from `.opencode/plugins/`): as of the latest stable **2.0.15** and the newest dev build **`0.0.0-dev-20081`**, there is **NO `ctx.session.list`** and no session-enumeration method. The `dist/` of 2.0.15 and `0.0.0-dev-20081` are byte-identical; `dist/promise/session.d.ts`, `dist/promise/plugin.d.ts`, `dist/promise/storage.d.ts`, `dist/promise/rpc.d.ts` are byte-identical between 2.0.11 and 2.0.15. Nothing after 2.0.11 adds it.
- **CLI/TUI plugins** (`@opencode/plugin/tui`, `Plugin.define({ setup(context) })`): **YES — sessions can be enumerated already in the installed 2.0.11** via `context.data.session.list(): SessionInfo[]` and via `context.client.session.list(...)` (the full `OpenCodeClient` is exposed as `context.client`). Verified directly in the published `dist/tui/context.d.ts`.
- There are **three unmerged PRs / an open issue** proposing to add `ctx.session.list` to the *server* plugin context. Only one is still open (PR #46690); the other two are closed unmerged. None is released.
- `ctx.rpc` **does exist** in the server plugin context and is a typed, generic RPC bridge — but it only reaches **plugin-registered RPC methods by definition id**, not arbitrary host HTTP routes. The generic `rpc.call(rpcID, method, input)` is **not** attached to the plugin context at runtime.
- `ctx.storage` exists but is **plugin-scoped KV** (namespace `plugin:${pluginID}`), not session storage — it cannot enumerate sessions.
- `ctx.app` exists (`{ name, version, channel }`); `ctx.experimental` exists but contains only `{ terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read"> }`.

---

## 1. Latest published versions (npm)

Checked live against `registry.npmjs.org`, 2026-09-24.

### `@opencode/plugin` (the V2 plugin package)
- **latest = `2.0.15`**, published **2026-09-23T07:15:13.958Z** (dist-tags: `latest: 2.0.15`, `dev: 0.0.0-dev-20081`, `beta: 0.0.0-beta-19507`, `reserved: 0.0.0-reserved`).
- **Versions after 2.0.11** (all stable):
  | version | published (UTC) |
  |---|---|
  | 2.0.12 | 2026-09-21T09:57:51.875Z |
  | 2.0.13 | 2026-09-22T10:07:32.238Z |
  | 2.0.14 | 2026-09-22T13:13:59.131Z |
  | 2.0.15 | 2026-09-23T07:15:13.958Z |
- Dev channel after that: `0.0.0-dev-20081`, published **2026-09-24T02:46:44.274Z**; newest dev builds are published many times a day (`...-20075` … `...-20081` on 2026-09-23/24).
- Registry page: https://www.npmjs.com/package/@opencode/plugin

### `@opencode/cli` (the V2 CLI)
- **latest = `2.0.15`**, published **2026-09-23T07:13:54.400Z**. Same 2.0.12–2.0.15 cadence as above.
- `package.json` `repository` = `git+https://github.com/anomalyco/opencode.git`; `bin` = `opencode` and `opencode2`. The npm tarball is a native-binary wrapper (`bin/opencode.exe` + `optionalDependencies` per platform); it ships **no type declarations**.
- Registry page: https://www.npmjs.com/package/@opencode/cli

### `opencode`
- **Does not exist on npm** — `https://registry.npmjs.org/opencode` returns no package metadata / no versions. Do not assume an `opencode` npm package.
- V1 lineage, for reference: CLI package `opencode-ai` (latest `1.18.32`, 2026-09-21) and plugin package `@opencode-ai/plugin` (latest `1.18.32`, 2026-09-21). GitHub Releases only carry the **v1.18.x** tags (latest `v1.18.32`, 2026-09-21); there are no V2 GitHub releases, and there is no CHANGELOG for the V2 npm packages.

### V2 repository / branch
- Source repo: **https://github.com/anomalyco/opencode**, V2 development branch **`v2`** (public; `raw.githubusercontent.com/anomalyco/opencode/v2/...` resolves, `main`/`dev` do not exist).
- Docs site: https://opencode.ai/v2/docs/

---

## 2. Changelog / release notes / commits about session listing, RPC bridge, `ctx.app`, `ctx.storage`, `experimental`

There are **no V2 changelog or release-notes artifacts**. What exists are PRs/issues. All quotes below were read from `api.github.com` / PR `.diff` files.

### 2a. `ctx.session.list` proposals (none released)

**PR #46690 — "feat(plugin): expose session forms, session list, and global event stream" — state: `open` (NOT merged)**, created 2026-09-02, last updated 2026-09-17.
https://github.com/anomalyco/opencode/pull/46690
Body quote:
> "While working on a telegram bot plugin for v2 (not included in this PR), I needed to expose more capabilities to enable plugin features.
> * mapping questions to telegram forms
> * listing sessions for telegram `/sessions` command
> * streaming session events to the telegram bot
> * expose interface for permissions, skills, compact, revert"

Its diff (`packages/plugin/src/promise/session.ts`) adds exactly:
```ts
/** Intentional subset of SessionApi["list"]: in-process only, no cursor/pagination. */
export interface SessionList {
  /** Filter to sessions created in this directory. Must be absolute; relative paths reject. */
  readonly directory?: string
  /** Maximum sessions to return. Truncates without a cursor; there is no pagination. */
  readonly limit?: number
}

/** In-process session listing — data layer shape, without HTTP cursor encoding. Truncated at `limit`. */
export type SessionListResult = {
  readonly data: Session.Info[]
}

export type SessionDomain = Pick<
  SessionApi,
  | "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate"
  | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait"
  | "compact" | "skill" | "revert" | "context"
> & {
  readonly list: (input?: SessionList) => Promise<SessionListResult>
  readonly hook: ModelHooks<SessionHooks>
  readonly form: FormDomain
}
```
So the proposed spelling is **`ctx.session.list({ directory?, limit? })` → `{ data: Session.Info[] }`** (Promise) / `Effect.Effect<{ data: Session.Info[] }, Error>` (Effect). **It exists in no published version.**

**PR #39939 — "feat(plugin): expose session list and messages with cursor pagination" — state: `closed`, merged: `false`** (created 2026-07-31, closed 2026-08-31).
https://github.com/anomalyco/opencode/pull/39939
Body quote:
> "Plugins gain `ctx.session.list` and `ctx.session.messages` with the same opaque cursor pagination as the HTTP endpoints — full client parity: identical inputs, identical `{ data, cursor: { previous, next } }` responses."

**PR #43556 — "feat(plugin): expose session history reads" — state: `closed`, merged: `false`** (created 2026-08-20, closed 2026-09-20).
https://github.com/anomalyco/opencode/pull/43556
Diff adds `"list"` to the `SessionDomain` `Pick` plus `children` and `messages`. Closed unmerged.

**Issue #44155 — "Expose session list and get in the Effect plugin API" — state: `open`** (created 2026-08-22).
https://github.com/anomalyco/opencode/issues/44155
Body quote (the whole body):
> "Add Effect plugin API methods for listing sessions and getting a session, matching capabilities already available in the HTTP client."

**Issue #34957 — "v2: internal tool plugins expose gaps in the public plugin API" — state: `open`** (created 2026-07-02). https://github.com/anomalyco/opencode/issues/34957
Quote:
> "`PluginRuntime` … exposes `session.{get,create,messages,prompt,resume,interrupt,synthetic}` … This overlaps awkwardly with the public `ctx.session` domain …"

### 2b. The RPC bridge origin
**PR #46105 — "feat(plugin): add typed rpc and custom events" — state: `closed`, merged: `true`, merged_at `2026-08-31T01:28:20Z`, merge commit `6a2c3e91c780e4291d72e75a148793557201a1f3`.**
https://github.com/anomalyco/opencode/pull/46105
Body quote:
> "Adds execution-neutral plugin RPC contracts with typed inputs, outputs, declared errors, and custom events. Promise and Effect plugins can register location-scoped implementations, while clients call them through one generic HTTP endpoint or subscribe through the existing event stream."

This is the merge that produced today's `ctx.rpc` (it shipped in `@opencode/plugin@2.0.0`, 2026-09-12). It is a bridge to **registered RPC methods**, not a generic host-HTTP proxy.

### 2c. `ctx.app`, `ctx.storage`, `experimental`
No commit/PR text was found that "adds" these after 2.0.11 — because they predate 2.0.11. Verified by unpacking published tarballs: `app`, `rpc`, `storage`, and `experimental` are all already present in **`@opencode/plugin@2.0.0`**'s `dist/promise/plugin.d.ts`. (`2.0.0` also had `catalog`; `2.0.10`+ replaced `catalog` with `model` + `provider`.) So none of these were introduced after 2.0.11, and none of them is a session-listing API.

---

## 3. Official V2 plugin docs: context domains and methods

Docs index: https://opencode.ai/v2/llms.txt (machine-readable page list).

| Page | URL |
|---|---|
| Plugins Overview (Context + API reference) | https://opencode.ai/v2/docs/build/plugins/ |
| RPC | https://opencode.ai/v2/docs/build/plugins/rpc/ |
| CLI (TUI/CLI plugins) | https://opencode.ai/v2/docs/build/plugins/cli/ |
| Migrate from V1 | https://opencode.ai/v2/docs/build/plugins/migrate-v1/ |
| Effect plugins | https://opencode.ai/v2/docs/build/plugins/effect/ |
| Effect RPC | https://opencode.ai/v2/docs/build/plugins/effect/rpc/ |
| JavaScript client | https://opencode.ai/v2/docs/build/client/ |
| API schemas | https://opencode.ai/v2/docs/api/ |

Docs source on GitHub (`v2` branch): https://github.com/anomalyco/opencode/blob/v2/services/www/src/docs/content/build/plugins/index.mdx (and `cli.mdx`, `rpc.mdx`, `migrate-v1.mdx` under the same directory).

### Server plugin (`@opencode/plugin`) `Context` domains (from `dist/promise/plugin.d.ts` = source `packages/plugin/src/promise/plugin.ts`)

`app`, `location`, `options`, `agent`, `aisdk`, `command`, `event`, `experimental` (`{ terminal: { read } }`), `integration`, `mcp`, `model`, `generate`, `permission`, `plugin` (`Pick<PluginApi, "list">`), `provider`, `reference`, `rpc`, `session`, `shell`, `skill`, `storage`, `tool`, `vcs`, `websearch`, `worktree`.

Exact `session` surface in the docs reference (https://opencode.ai/v2/docs/build/plugins/#sessions):
```ts
interface SessionContext {
  create(input?: SessionCreateInput, requestOptions?: RequestOptions): Promise<SessionInfo>
  get(input: SessionGetInput, requestOptions?: RequestOptions): Promise<SessionInfo>
  context(input: SessionContextInput, requestOptions?: RequestOptions): Promise<readonly SessionMessageInfo[]>
  switchAgent(input: SessionSwitchAgentInput, requestOptions?: RequestOptions): Promise<void>
  switchModel(input: SessionSwitchModelInput, requestOptions?: RequestOptions): Promise<void>
  prompt(input: SessionPromptInput, requestOptions?: RequestOptions): Promise<SessionInboxUser>
  generate(input: SessionGenerateInput, requestOptions?: RequestOptions): Promise<{ text: string }>
  command(input: SessionCommandInput, requestOptions?: RequestOptions): Promise<SessionInboxUser>
  synthetic(input: SessionSyntheticInput, requestOptions?: RequestOptions): Promise<SessionInboxSynthetic>
  interrupt(input: SessionInterruptInput, requestOptions?: RequestOptions): Promise<void>
  rename(input: SessionRenameInput, requestOptions?: RequestOptions): Promise<void>
  wait(input: SessionWaitInput, requestOptions?: RequestOptions): Promise<void>
}
```
**No `list`.** (Minor docs/source drift: the docs reference says `rename`, while the 2.0.15 `d.ts`/source `Pick` says `update` — the actual released Pick is `"update"`, and `packages/core/src/plugin/host.ts` wires `update` to `sessions.rename`/`sessions.setPermissions`.)

Storage, quoted from the docs (https://opencode.ai/v2/docs/build/plugins/#storage):
> "### Storage — Store, read, or remove durable JSON values scoped to the plugin."
```ts
interface StorageContext {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  remove(key: string): Promise<void>
  scan(options: StorageScanOptions): Promise<StorageScanResult>
}
```
i.e. `scan({ prefix })` enumerates **plugin-owned keys only**, not sessions.

RPC (https://opencode.ai/v2/docs/build/plugins/rpc/):
> "Plugins can expose custom methods and events that run on the server and can be called by other plugins or clients."
> "Once the RPC is registered, it can be called over HTTP or from another plugin."

### CLI/TUI plugin (`@opencode/plugin/tui`) `Context`
Documented at https://opencode.ai/v2/docs/build/plugins/cli/ (`services/www/src/docs/content/build/plugins/cli.mdx`).

Domains: `options`, `location`, `app`, `renderer`, `client`, `data`, `attention`, `theme`, `themeMode`, `markdown`, `keymap`, `storage`, `ui`.

Docs quote (CLI page, "Client"):
> "`context.client` is the generated OpenCode client and can call the connected server, including a remote server."

Docs quote (CLI page, "Sessions"):
> "Session data exposes list, lookup, hierarchy, cost, status, synchronization, and invalidation."
```ts
const sessions = context.data.session.list()
const session = context.data.session.get(sessionID)
const rootID = context.data.session.root(sessionID)
const familyIDs = context.data.session.family(sessionID)
const cost = context.data.session.cost(sessionID)
const status = context.data.session.status(sessionID)
```

---

## 4. Source repository and the files that define the plugin context

Repo: **https://github.com/anomalyco/opencode** (branch **`v2`**).

| What | Link |
|---|---|
| Server plugin `Context` (Promise) | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/plugin.ts |
| Server plugin `Context` (Effect) | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/effect/plugin.ts |
| Server `SessionDomain` (Promise) | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/session.ts |
| Server `SessionDomain` (Effect) | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/effect/session.ts |
| Context construction / host wiring | https://github.com/anomalyco/opencode/blob/v2/packages/core/src/plugin/host.ts |
| TUI/CLI plugin `Context` | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/tui/context.ts |
| RPC domain type | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/rpc.ts |
| Storage domain type | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/storage.ts |
| App metadata type | https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/app.ts |

### Quoted session domain definition — current `v2` branch (matches published 2.0.15 exactly)

`packages/plugin/src/promise/session.ts`:
```ts
export type SessionDomain = Pick<
  SessionApi,
  | "create"
  | "get"
  | "switchAgent"
  | "switchModel"
  | "prompt"
  | "generate"
  | "command"
  | "synthetic"
  | "interrupt"
  | "update"
  | "move"
  | "wait"
  | "context"
> & {
  readonly hook: ModelHooks<SessionHooks>
}
```

The underlying `SessionApi` (from `@opencode/client/promise/api` → the generated client) **does** include `list`, `stats`, `active`, `remove`, `fork`, `import`, `export`, `skill`, `shell`, `compact`, `revert`, `diff`, `inbox`, `instructions`, `log` — the plugin `Pick` deliberately drops all of them.

Also relevant, from `packages/core/src/plugin/host.ts`:
```ts
rpc: Object.assign(rpc.client, { register: rpc.register }),
...
storage: storage(kv, pluginID),
...
export function storage(kv: KV.Interface, pluginID: string): Plugin.Context["storage"] {
  const namespace = `plugin:${pluginID...
```
and the host's `session` object (lines ~518-556) implements exactly `create/get/switchAgent/switchModel/prompt/generate/command/update/move/synthetic/interrupt/wait/context/hook` — **no `list`**. `ctx.storage` namespaces keys under `plugin:${pluginID}`.

### Generic host call surface
- `packages/core/src/rpc.ts` defines `readonly call: (rpcID: string, method: string, input: unknown) => ...` plus `readonly client: <D>(definition: D) => RpcClient<D,...>`.
- The plugin context binds only `rpc.client` + `rpc.register` (`Object.assign(rpc.client, { register })`), so the free-form `call(rpcID, method, input)` is **not** on `ctx.rpc`.
- The `@opencode/client` package (not the plugin context) *does* expose a generic escape hatch: `OpenCode.make()` returns `rpc: RpcApi & { call: (input: RpcCallInput, ...) => Promise<RpcOutput> }`. A **TUI plugin** receives that full client as `context.client`, so a TUI plugin can call any client operation, including `context.client.session.list(...)`.

---

## How to verify locally

Everything below is read-only inspection.

1. **Server plugin session domain (should have no `list`):**
   - Bun layout: `node_modules/.bun/@opencode+plugin@2.0.11+1c4c7ac8a7979686/node_modules/@opencode/plugin/dist/promise/session.d.ts`
   - Symlinked path: `node_modules/@opencode/plugin/dist/promise/session.d.ts`
   - Look for `export type SessionDomain = Pick<SessionApi, "create" | "get" | ...>` — confirm `"list"` is absent.
2. **Full server plugin context domains:** `node_modules/@opencode/plugin/dist/promise/plugin.d.ts` (`interface Context { ... }`) → contains `app`, `rpc`, `session`, `storage`, `experimental`.
3. **TUI/CLI plugin context (should HAVE session listing):** `node_modules/@opencode/plugin/dist/tui/context.d.ts`
   - line 38-39: `readonly session: { list(): SessionInfo[]; ... }` (this is `context.data.session`)
   - line 449: `readonly client: OpenCodeClient;`
4. **Storage scoping:** `node_modules/@opencode/plugin/dist/promise/storage.d.ts` (`get/set/remove/scan`) — plugin KV only.
5. **RPC:** `node_modules/@opencode/plugin/dist/promise/rpc.d.ts` (`RpcDomain extends RpcApi<...>` + `register`).
6. **To check a newer version without installing:** `npm pack @opencode/plugin@2.0.15` (or fetch `https://registry.npmjs.org/@opencode/plugin/-/plugin-2.0.15.tgz`), then `grep -n "SessionDomain" -A 20 package/dist/promise/session.d.ts`. Repeat for the `dev` dist-tag version `0.0.0-dev-20081`. Both are byte-identical to 2.0.11 for `session.d.ts` / `plugin.d.ts` / `storage.d.ts` / `rpc.d.ts`.

---

## Practical implication for the omo port

- If session enumeration is required from the **server** plugin (the current omo adapter), no released API provides it as of 2.0.15 / `0.0.0-dev-20081`. Options: (a) rely on the TUI plugin context (`context.data.session.list()` / `context.client.session.list(...)`) if a TUI companion plugin is acceptable, (b) track sessions the plugin itself creates via `ctx.session.hook` + `ctx.event.subscribe`, or (c) call the host HTTP API out-of-band from the plugin process (the plugin Context exposes no `client`/fetch bridge, so this is outside the plugin API).
- Watch PR #46690 (open, unmerged) if `ctx.session.list` on the server context is wanted later.
- Do not use `ctx.rpc` as a generic HTTP proxy; it only reaches RPC methods registered via `ctx.rpc.register` (or built-in ones with a matching definition id).

---

## Verbatim registry snapshot (for reproducibility)

```
@opencode/plugin  dist-tags: {reserved:0.0.0-reserved, beta:0.0.0-beta-19507, latest:2.0.15, dev:0.0.0-dev-20081}
@opencode/cli     dist-tags: {reserved:0.0.0-reserved, beta:0.0.0-beta-19507, latest:2.0.15, dev:0.0.0-dev-20081}
@opencode-ai/plugin latest: 1.18.32 ; opencode-ai latest: 1.18.32 ; opencode: no such npm package
```
