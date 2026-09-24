# P5-A7 provider `connected` semantics — assessment: stay unimplemented (2026-09-24)

The parity plan re-opened this item after the research found `ctx.integration.connection.active(id)`
and `resolve(connection)`, on the theory that they give the credential/connection truth the earlier
verdict said was missing. A live probe on this machine's real provider config says otherwise.

Probe: isolated `XDG_*` with the real `providers` block copied from
`~/.config/opencode/opencode.json` (deepseek, litellm, new-api, plus the built-in `opencode`),
a plugin that dumps `ctx.provider.list()`, `ctx.integration.list()` and
`connection.active(integrationID)` per provider. Raw data: `live-provider-connections.json`.

## Observed

```
providers listed by ctx.provider.list():  1 entry
  { id: "opencode", integrationID: "opencode", activation: "enabled", hasSettingsKey: true }

integration catalogue:                    225 entries (302.AI, Abacus, AI21, ...)
integrations with >=1 connection:         0
connection.active("opencode"):            "none"     (while that provider demonstrably works)
```

The config-declared providers this machine actually uses (`deepseek`, `litellm`, `new-api`) do not
appear in `provider.list()` at all, and the built-in `opencode` provider reports no active connection
even though its `settings.apiKey` is set and requests succeed through it.

## Why implementing it would be wrong

- `integration.connections` / `connection.active` describe **OAuth/credential integrations**, not
  "this provider is usable". Every working provider here is configured with an inline `apiKey` or
  `settings`, which is invisible to that API.
- `connected` derived from this data would be the empty set (or, on a host with OAuth connections, a
  partial set containing only those). `fetchAvailableModels` treats an empty/unknown set as "unknown"
  and falls back to `client.model.list()` - so the empty case changes nothing, while a partial set
  would **exclude providers the user can actually use**.
- `provider.list()` cannot even supply `all`: it lists 1 provider here, not the four on this machine.

The earlier verdict ("not implementable, and nothing is lost because the fallback yields the same
model set") therefore stands, now with measurements instead of inference. omo's `getConnectedProviders`
keeps logging `client.provider.list not available` and the model set keeps coming from `model.list()`.

## What would change this

A V2 API that reports *usable credentials per provider* (the client's `credential` domain exists but is
not on the plugin context, and `ProviderInfo` carries only `activation`/`settings`). If a future V2
exposes it, revisit; until then this stays a documented decision, not a gap.
