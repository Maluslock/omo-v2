# QA evidence — V2 MCP port (`ctx.mcp.transform`)

Date: 2026-09-23
Host: opencode 2.0.11 (real managed service, port 49374, real `~/.config/opencode/opencode.json`)
Plugin under test: `/home/user/omo-v2/dist/index.js` (locally built from this working tree), loaded
into probe directories via `.opencode/plugins/omo-local.ts` (`export { default } from "<dist>"`).

## What was tested

The newly added V2 MCP registration path:

- `packages/omo-opencode/src/v2/mcp-mapping.ts` — V1 built-in MCP config to V2 `Mcp.ServerConfig`
- `packages/omo-opencode/src/v2/register-mcps.ts` — `ctx.mcp.transform` set/update
- `packages/omo-opencode/src/v2/create-v2-plugin.ts` — wiring (`await registerOmoMcps(...)`)

Claim under test: **when omo's V2 plugin loads, the omo built-in MCP servers actually start on the
host and expose their tools, and omo's config gating is honoured.**

## Command

```bash
# positive: default config (lsp built-in enabled)
cd /home/user/ocaudit7 && opencode run --model deepseek/deepseek-v4-pro "Reply with exactly: AUDIT_OK"

# negative control: same plugin, lsp gate closed
# /home/user/ocaudit8/.omo/omo.jsonc => { "[opencode]": { "disabled_mcps": ["lsp"] } }
cd /home/user/ocaudit8 && opencode run --model deepseek/deepseek-v4-pro "Reply with exactly: AUDIT_OK"
```

## What was observed

omo-side registration (`/tmp/oh-my-opencode.log`):

```
[v2] mcps registered {"registered":5,"names":["websearch","context7","grep_app","lsp","codegraph"]}   # ocaudit7
[v2] mcps registered {"registered":4,"names":["websearch","context7","grep_app","codegraph"]}        # ocaudit8
```

Host-side MCP lifecycle (`~/.local/share/opencode/log/opencode.log`, `message="mcp connected"`):

```
dir=/home/user/ocaudit7 server=lsp tools=8
dir=/home/user/ocaudit7 server=websearch tools=1
dir=/home/user/ocaudit7 server=context7 tools=2
dir=/home/user/ocaudit7 server=grep_app tools=1
dir=/home/user/ocaudit7 server=codegraph tools=0
dir=/home/user/ocaudit8 server=grep_app tools=1          # lsp: ABSENT
dir=/home/user/ocaudit8 server=codegraph tools=0
```

Raw artifact: `live-mcp-audit3.log`.

### Re-verification after the typed-mapper refactor

`toV2McpConfig` was later tightened to return the real `Mcp.ServerConfig` union and to build its
object key-by-key (the host declares these fields with `optionalKey`, which accepts an absent key
but rejects an explicit `undefined` value, so the earlier spread form could have emitted
`headers: undefined`). The bundle was rebuilt and re-verified in a **fresh** directory
(`/home/user/ocaudit9`) so every MCP server had to connect from scratch:

```
06:51:12.266Z  [v2] mcps registered {"registered":5,"names":["websearch","context7","grep_app","lsp","codegraph"]}
06:51:13.237Z  server=lsp tools=8
06:51:13.557Z  server=codegraph tools=0
06:51:16.137Z  server=grep_app tools=1
```

One second between the omo registration and the `lsp` handshake, in the same run. (The remote
servers connect later; a re-run in an already-connected directory logs nothing new, which is why
the first recheck showed no new line — MCP connections are per directory and cached by the host,
so verification must use a directory the host has not seen.)

Reading: with the gate open omo registers 5 MCPs and the host launches the stdio `lsp` server,
which connects and reports **8 tools** (`lsp_status`, `lsp_diagnostics`, ... — the 8 LSP aliases
the V1 plugin also served through this MCP). With `disabled_mcps: ["lsp"]` omo registers 4 and the
host never connects an `lsp` server in that directory. The connection is therefore caused by the
V2 registration path, and omo's config gating survives the port.

## Why it is enough

The `mcp connected ... tools=8` line is produced by the host's own MCP client after a successful
stdio handshake with `packages/lsp-tools-mcp/dist/cli.js`. It cannot be emitted by omo's transform
alone, so it proves the config omo handed to `ctx.mcp.transform` was accepted by the host and
acted upon. The negative control removes the alternative explanation (that opencode ships its own
`lsp` MCP): with the omo entry gone, the server never starts.

## What was omitted / not proven

- **Model-facing tool invocation was not exercised end to end.** Prompting the model to call
  `lsp_status` fails on this host with the pre-existing gateway limitation
  `Error: OpenAI Chat user messages only support text and media content for now`, which aborts any
  tool-result turn (the built-in `glob` tool reproduces it too). The tools are registered on the
  host (`tools=8`); the model round trip is blocked by the gateway, not by the port.
- **`ctx.tool.list()` / `ctx.mcp.list()` cannot be used as a registration-time oracle.** At plugin
  setup both return empty (`ctx.tool.list({})` returned `{}`) because the host's transform is lazy
  and MCP servers connect asynchronously after setup. Earlier probe runs that reported a tool total
  of 68 → 74 were catching whichever servers had finished connecting at that instant; that number is
  timing-dependent and must not be quoted as a registration contract.
- The other MCP servers visible in the directories (`playwright`, `ssh`, `postgres`, ...) come from
  the machine's `.mcp.json` / global config, not from omo.

## Second finding (not part of this port, reported because it is a live breakage)

The **published** `oh-my-openagent@latest` is loaded by the user's real global config
(`~/.config/opencode/opencode.json` -> `"plugin": ["superpowers@...", "oh-my-openagent@latest"]`)
and **fails to load on opencode 2.0.11**, 502 times in the host log:

```
level=WARN message="failed to load plugin" target=oh-my-openagent@latest
cause="PluginModule.LoadError: Plugin must export a default definition with an id and an effect or
setup function. (cause: SchemaError(Missing key at ["default"]["effect"] / Missing key at ["default"]["setup"]))"
```

The installed package's bundle exports `{ id: "oh-my-openagent", server: ... }` — the V1 shape. V2
no longer accepts `server`; it wants `setup` or `effect`. So on this host the user's omo is
currently entirely dead, and only the local V2 shim registers anything.

Raw artifact: `v1-published-plugin-rejected.log`.
