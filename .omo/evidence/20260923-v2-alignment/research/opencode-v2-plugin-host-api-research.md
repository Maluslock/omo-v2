# OpenCode V2 plugin → host HTTP API: how to reconstruct a client (research report)

Scope: `@opencode/plugin` 2.0.11 (OpenCode V2 server plugin API). Question: can a plugin running
**inside** the V2 server reach the server's own HTTP API, and what is the documented/supported way?

Method: web research only; primary sources (official docs at opencode.ai/v2, npm package metadata
via jsDelivr, the installed `@opencode/plugin@2.0.11` typings in this workspace, `anomalyco/opencode`
issues, and real third-party plugin source). No repository code was modified.

Environment note (verified locally): this workspace has `@opencode/plugin@2.0.11`
(`node_modules/@opencode/plugin/package.json`), which declares `@opencode/client@2.0.11` as a
**runtime dependency**.

---

## TL;DR

1. **A V2 server plugin gets no client and no base URL.** There is no `ctx.client`, `ctx.baseUrl`,
   `ctx.server`, `ctx.port`, or documented env var for "the server I am running in".
2. **The supported in-process route is `ctx` itself.** The docs call the plugin context
   "essentially an OpenCode server client"; its domains (`ctx.session`, `ctx.tool`, `ctx.permission`,
   ...) are typed as the *same* API surfaces as `@opencode/client`. No HTTP hop is needed or intended.
3. A literal HTTP client is available as the public package `@opencode/client`
   (`OpenCode.make({ baseUrl, headers })`), and `@opencode/client/service`
   (`Service.discover/ensure/headers`) can find a local server URL + auth headers from
   `~/.local/state/opencode/service.json`. **But both are documented for out-of-process clients, not
   for in-server plugins**, and discovery targets the *shared background service* — which may not be
   the server instance the plugin is loaded into.
4. Auth is HTTP **Basic** (`Authorization: Basic base64(user:pass)`) with username `opencode`
   (`OPENCODE_SERVER_USERNAME`) and password `OPENCODE_SERVER_PASSWORD`; it is **off by default**
   (no auth for localhost unless a password is configured).
5. Every real-world V2 plugin found reaches the host through **`ctx` in-process** — none reconstructs
   an HTTP client to call its own server.

---

## 1. Official way to obtain a client / base URL for the running server

**Answer: there is none for server plugins. Use the in-process context instead.**

The official V2 plugin context type (`@opencode/plugin@2.0.11`,
`dist/promise/plugin.d.ts`, installed in this workspace) is:

```ts
export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly event: EventDomain
  readonly experimental: { readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read"> }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}
```

There is **no `client`, no URL, no port**. Confirmed by the docs:

- [Plugins overview](https://opencode.ai/v2/docs/build/plugins) — "The plugin context is essentially
  an [OpenCode server client](https://opencode.ai/v2/docs/build/client). Its read and action methods use the same inputs
  and responses as the client. It adds plugin-only methods for transforms, runtime hooks, reloads,
  registrations, and plugin options."
- [Migrate from V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1) — the migration table maps
  the V1 SDK `client` directly to domain methods:

  | V1 | V2 |
  | --- | --- |
  | `directory` | `ctx.location.directory` |
  | `project` | `ctx.location.project` |
  | `client` | Domain methods such as `ctx.session`, `ctx.permission`, `ctx.agent` |
  | plugin options argument | `ctx.options` |

- [Effect plugins](https://opencode.ai/v2/docs/build/plugins/effect) — "The context exposes the
  Effect client for the connected OpenCode server plus plugin-only transforms, hooks, storage,
  reloads, and options. **It does not expose OpenCode's private Core services.**"

What the candidate fields actually are:

- `ctx.options` = **plugin** options from `opencode.json(c)` (`{"package": ..., "options": {...}}`),
  not server details — [Options section](https://opencode.ai/v2/docs/build/plugins).
- `ctx.location` = the plugin instance's location: `directory`, optional `workspaceID`, and
  `project` metadata (`id`, `directory`, `canonical`) — a filesystem/project location, **not a URL**
  ([Plugins overview](https://opencode.ai/v2/docs/build/plugins)).
- The only client-ish thing on the context is `experimental.terminal` (a narrowed `persistentPty.read`
  pick) and `ctx.plugin.list` (a narrowed `PluginApi.list` pick) — both explicitly `Pick<...>`.

**Documented discovery mechanism (out-of-process Node only):** `@opencode/client/service`
([client docs](https://opencode.ai/v2/docs/build/client)):

- `Service.discover()` "returns a healthy registered endpoint without starting a process."
- `Service.ensure()` "returns a compatible service, starting one when needed."
- `Service.headers(endpoint)` "creates the authentication headers for a client."

The registration file and its contents are documented:

- [Troubleshooting → Service files](https://opencode.ai/v2/docs/troubleshooting): "The shared server
  registers itself at `~/.local/state/opencode/service.json`."
- `@opencode/client@2.0.11` `dist/service.d.ts` (fetched via jsDelivr) — `discover()` returns
  `{ url, auth?: { type: "basic", username, password } }`, and the registration `Info` type is
  `{ id?, version?, url, pid, password? }` where `password` is documented as "Private service
  password, when authentication is enabled."

**Caveat (important, and not documented as a plugin pattern):** discovery resolves the **shared
background service**, not necessarily the server the plugin runs in. The CLI docs
([CLI intro → Background service](https://opencode.ai/v2/docs/cli/)) say OpenCode "discovers or starts
one shared background server for your user account" and `--standalone` runs "with a private server";
`--server <url>` connects to a specific server. So a plugin inside `--standalone`/`--server` cannot
assume `service.json` describes its own process. **I could not find any doc that blesses
`Service.discover()` from inside a server plugin.**

## 2. Is `@opencode/client` a supported dependency for plugins?

**Answer: it is a real, public package and is present in a plugin's dependency tree, but the plugin
docs do not document using it to call the host; they steer you to `ctx` domains.**

- Package metadata (`cdn.jsdelivr.net/npm/@opencode/client@2.0.11/package.json`): `"publishConfig":
  {"access": "public"}`, exports `.`, `./promise`, `./promise/api`, `./service`, `./solid`,
  `./effect`, `./effect/service`. Its README calls it "Private generation target for clients derived
  directly from OpenCode's authoritative Effect `HttpApi`" (i.e., generated from the same contract as
  the server).
- `@opencode/plugin@2.0.11` depends on `@opencode/client@2.0.11` (and `@opencode/protocol`,
  `@opencode/schema`), so it is installed alongside the plugin.
- Docs: ["`@opencode/client` is the TypeScript client for the OpenCode HTTP API. Use it when your
  application connects to an OpenCode server **over the network**."](https://opencode.ai/v2/docs/build/client)
- The [RPC docs](https://opencode.ai/v2/docs/build/plugins/rpc) show constructing it, but for an
  **HTTP caller**; the in-plugin path they show is `ctx.rpc(Acme)` ("Plugins already have an OpenCode
  client"), and for TUI plugins `context.client`.

Minimal documented construction:

```ts
import { OpenCode } from "@opencode/client"

const client = OpenCode.make({
  baseUrl: "http://localhost:4096",
})

const session = await client.session.create({ location: { directory: "/workspace" } })
await client.session.prompt({ sessionID: session.id, text: "Review the current changes" })
```

With discovery + auth headers (documented for a Node app):

```ts
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

const endpoint = await Service.ensure()
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint), // { authorization } | undefined
})
const info = await client.server.info()
```

Headers can also be passed per client explicitly
([client docs](https://opencode.ai/v2/docs/build/client)):

```ts
const client = OpenCode.make({
  baseUrl: "https://opencode.example.com",
  headers: { authorization: `Bearer ${process.env.OPENCODE_TOKEN}` },
})
```

Version/name facts (useful when pinning): V2 is published as `@opencode/cli` (2.x; exposes an
`opencode2` binary alias), `@opencode/plugin`, `@opencode/client`, `@opencode/sdk`, `@opencode/schema`.
V1 used the `@opencode-ai/*` scope. (Hindsight PR
[#4351](https://github.com/vectorize-io/hindsight/pull/4351) documents the rename and pins
`@opencode/plugin@^2.0.3` as the first stable V2 line.)

**Not verified:** the docs never state "a server plugin may import `@opencode/client`". Treat that as
unsupported until proven otherwise.

## 3. What authentication does the server require for local HTTP calls?

**Answer: none by default. If protected, HTTP Basic with username `opencode`
(`OPENCODE_SERVER_USERNAME`) and password `OPENCODE_SERVER_PASSWORD`.**

- [V1 Server docs → Authentication](https://opencode.ai/docs/server): "Set `OPENCODE_SERVER_PASSWORD`
  to protect the server with HTTP basic auth. The username defaults to `opencode`, or set
  `OPENCODE_SERVER_USERNAME` to override it. This applies to both `opencode serve` and `opencode web`."
  Example: `OPENCODE_SERVER_PASSWORD=your-password opencode serve`.
- V2 client/service side: `Service.discover()` returns
  `auth: { type: "basic", username, password }` and `Service.headers(endpoint)` returns
  `{ authorization: string } | undefined` (`@opencode/client@2.0.11` `dist/promise/service.d.ts`).
- V2 docs example clients call `http://localhost:4096` with **no** headers, i.e. localhost is
  unauthenticated unless a password is configured
  ([client docs](https://opencode.ai/v2/docs/build/client),
  [RPC docs](https://opencode.ai/v2/docs/build/plugins/rpc)).
- Every operation in the V2 OpenAPI reference lists a `401 UnauthorizedError` response
  ([API reference](https://opencode.ai/v2/docs/api)). I fetched `/v2/openapi.json` but only the first
  ~100 KB (paths) came back, so I **could not verify** a `components.securitySchemes` entry or quote
  the auth middleware.
- The known failure mode is documented as GitHub issues: [#8676 "Plugin client returns 401
  Unauthorized when OPENCODE_SERVER_PASSWORD is set (Desktop)"](https://github.com/anomalyco/opencode/issues/8676)
  and [#12846 "OpenCode plugins cannot use `client` when the server has a password"](https://github.com/anomalyco/opencode/issues/12846).
  #8676 shows the V1 plugin's client was created in-process with a shimmed fetch and proposed adding:

  ```ts
  const credentials = Buffer.from(`${username}:${OPENCODE_SERVER_PASSWORD}`).toString("base64")
  authHeaders["Authorization"] = `Basic ${credentials}`
  ```

- Header name: `authorization` (the client docs/`Service.headers` return key), value
  `Basic <base64(username:password)>`.

## 4. Real-world third-party OpenCode V2 plugins and how they reach the host

At least four, all sourced from actual code. **None of them reconstruct an HTTP client to call the
host API — every one uses the in-process `ctx`.**

1. **vectorize-io/hindsight — `@vectorize-io/hindsight-coding-agents` (opencode2 adapter)**
   [src/harness/opencode2.ts](https://raw.githubusercontent.com/vectorize-io/hindsight/main/hindsight-integrations/coding-agents/src/harness/opencode2.ts)
   · [PR #3985](https://github.com/vectorize-io/hindsight/pull/3985) · npm
   `@vectorize-io/hindsight-coding-agents`.
   Approach: reads the transcript with `ctx.session.context({ sessionID })`, hooks turns with
   `ctx.session.hook("prompt" | "context")`, registers native tools with `ctx.tool.transform`, streams
   events with `ctx.event.subscribe({ signal })`, registers a skill with `ctx.skill.transform`. No
   client, no base URL. The source also documents host gaps: "v2's `ctx.agent.transform` draft exposes
   only list/get/default/update/remove — a plugin cannot DEFINE an agent", and "v2's plugin client can
   OBSERVE `tui.toast.show` events but cannot publish one".

2. **alvinunreal/oh-my-opencode-slim (dual V1/V2)**
   [PR #1109 diff](https://github.com/alvinunreal/oh-my-opencode-slim/pull/1109) ·
   `docs/opencode-v2-compatibility.md` + `src/v2/client-shim.ts`.
   Approach: builds a v1-shaped `PluginInput` whose `client` **really delegates** old SDK call shapes
   to V2 in-process session calls — `session.get`, `session.abort`→`interrupt`,
   `session.messages`→`context`, `session.prompt` (as `delivery: "steer"`),
   `session.update`→`rename` — plus `ctx.agent.transform`, `ctx.tool.transform`,
   `ctx.command.transform`, `ctx.mcp.transform`, `ctx.tool.hook`, `ctx.event.subscribe`. It explicitly
   lists **"Never fakes success shapes (no invented `serverUrl`)"** and resolves the directory from
   `ctx.location.directory` (older builds: `process.cwd()`). This is the strongest third-party
   confirmation that V2 exposes no server URL to plugins.

3. **alibaba/open-code-review — OpenCode 2.x entrypoint**
   [PR #1213 diff](https://github.com/alibaba/open-code-review/pull/1213).
   Approach: one file exporting `{ id, setup, server }`; the V2 `setup(ctx)` registers two tools via
   `ctx.tool.transform`, reads existing commands via `ctx.command.list()`, adds commands via
   `ctx.command.transform`, and sends prompts with `ctx.session.prompt({ sessionID, text, delivery })`.
   It resolves the per-session working directory from `ctx.session.get({ sessionID })` /
   `ctx.location.directory`. No host HTTP.

4. **rtk-ai/rtk — V2 plugin payload**
   [PR #4197 diff](https://github.com/rtk-ai/rtk/pull/4197) (`hooks/opencode/rtk-v2.ts`).
   Approach: `export default Plugin.define({ id: "rtk", async setup(ctx) { await ctx.tool.hook("execute.before", ...) } })`,
   mutating the tool input in place; the actual work is a `node:child_process` call to the `rtk`
   binary. It notes V1 and V2 plugin APIs are mutually incompatible and detects the major version via
   the installed plugin package (`@opencode/plugin` → V2, `@opencode-ai/plugin` → V1).

Adjacent data point: `diegosouzapw/OmniRoute` ships `@omniroute/opencode-plugin-v2`, whose `baseURL`
option is the **gateway** address (its own service), not the OpenCode server — so it is not a
self-connect example.

## 5. Is there an in-process alternative to HTTP self-calls?

**Yes — it is the primary/supported API. The context domains are the client, and plugin RPC +
the event stream cover extension points.**

- **Context domains = in-process client.** Docs: "The plugin context is essentially an OpenCode
  server client" ([Plugins overview](https://opencode.ai/v2/docs/build/plugins)); "The context exposes
  the Effect client for the connected OpenCode server ... It does not expose OpenCode's private Core
  services" ([Effect plugins](https://opencode.ai/v2/docs/build/plugins/effect)). In the typings, each
  domain extends the generated client API — e.g.
  `SessionDomain = Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait" | "context">`
  (`@opencode/plugin@2.0.11`, `dist/promise/session.d.ts`). Method names/shapes match the HTTP
  operation IDs (`session.create`, `session.prompt`, `session.context`, ...) but require no URL.
- **Plugin RPC**: `ctx.rpc.register(definition, handlers)` registers host-registered methods, and the
  same plugin calls them through `ctx.rpc(Definition)`
  ([RPC docs](https://opencode.ai/v2/docs/build/plugins/rpc)). HTTP is only for *external* callers:
  "Any HTTP client can also invoke the generic `POST /api/rpc/{rpcID}/{method}` route with
  `{ "input": ... }`". The `RpcDomain` type in the installed typings forbids `location` and `headers`
  options (`RpcDomain` narrows `RpcCallOptions` to `{ signal }` with `location?: never;
  headers?: never`), i.e. in-process only.
- **Event stream as the internal bus surface**: `ctx.event.subscribe({ signal })` (async iterable) is
  the V2 replacement for V1's `event` hook; `ctx.rpc` events are subscribable via
  `registration.events.emit(...)`, `subclient.events.on(...)`, `events.subscribe(...)`
  ([RPC docs](https://opencode.ai/v2/docs/build/plugins/rpc)).
- **Embedded host**: `@opencode/sdk` `OpenCode.create()` "assembles the OpenCode server and routes API
  calls through its HTTP router **in memory**. It opens no HTTP listener and adds no network hop"
  ([SDK docs](https://opencode.ai/v2/docs/build/sdk)). This confirms the in-process router exists;
  for a plugin, the exposed handle is `ctx`'s domains.

---

## What this means for the omo V2 port (inference, not documentation)

- Port V1 `client.*` calls to the matching `ctx.<domain>.*` call, in-process. There is no base URL to
  reconstruct and no supported way to obtain one; do not hardcode `http://localhost:4096` or read
  `OPENCODE_SERVER_PASSWORD` to build a client for one's own server.
- `rpc.call` / routes with no `ctx` domain are the only realistic reason to want HTTP; the supported
  substitute is register-your-own-RPC + call it with `ctx.rpc(def)`, or use the domain that owns the
  operation.
- If HTTP self-calls are truly required, the only documented construction primitives are
  `OpenCode.make({ baseUrl, headers })` + `Service.discover()/ensure()/headers()`, with the
  caveats in §1 (shared-service discovery; no plugin blessing).

## Explicitly NOT verified

- No `OPENCODE_PORT` / `OPENCODE_SERVER_URL` (or similar) env var is documented for V2. V1 docs
  document `--port`/`--hostname` flags only (default port `4096`). I could not find any V2 doc naming
  a server-URL env var.
- V2 `components.securitySchemes` / the exact server auth middleware: `/v2/openapi.json` was too
  large to retrieve in full, and the V2 docs do not restate the `OPENCODE_SERVER_PASSWORD` mechanism
  (only V1 docs do).
- Whether `@opencode/client/service` discovery resolves the server a given plugin instance runs in
  (shared service vs `--standalone`/`--server`): not documented either way.
- No documentation declaring `@opencode/client` a supported import *inside server plugins*.
- The RPC route path `POST /api/rpc/{rpcID}/{method}` is quoted from the client docs page; the API
  reference lists the operation as `rpc.call` (I did not retrieve its exact path from the OpenAPI JSON).

## Source index

- Plugins overview: https://opencode.ai/v2/docs/build/plugins
- Plugin RPC: https://opencode.ai/v2/docs/build/plugins/rpc
- Migrate from V1: https://opencode.ai/v2/docs/build/plugins/migrate-v1
- Client (Promise): https://opencode.ai/v2/docs/build/client
- Client (Effect): https://opencode.ai/v2/docs/build/client/effect
- Plugins (Effect): https://opencode.ai/v2/docs/build/plugins/effect
- SDK (embedded): https://opencode.ai/v2/docs/build/sdk
- Configure plugins: https://opencode.ai/v2/docs/plugins
- API reference: https://opencode.ai/v2/docs/api
- Troubleshooting (service files): https://opencode.ai/v2/docs/troubleshooting
- V1 Server (auth): https://opencode.ai/docs/server
- `@opencode/client@2.0.11` package + `dist/promise/service.d.ts` + `dist/service.d.ts`:
  https://cdn.jsdelivr.net/npm/@opencode/client@2.0.11/package.json
- Installed typings: `node_modules/@opencode/plugin/dist/promise/plugin.d.ts`, `session.d.ts`,
  `rpc.d.ts`, `tui/context.d.ts` (v2.0.11)
- Issues #8676, #12846 (plugin 401s with `OPENCODE_SERVER_PASSWORD`)
- Real plugins: hindsight PR #3985 / raw `src/harness/opencode2.ts`; oh-my-opencode-slim PR #1109;
  alibaba/open-code-review PR #1213; rtk-ai/rtk PR #4197
