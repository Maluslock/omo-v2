# `session_list` / `session_search` / `session_info` on V2 (evidence)

Date: 2026-09-24
Harness: `.omo/tmp/session-index-probe` — isolated `XDG_*` (providers copied from the real config, no
`plugins` list) plus a project `.opencode/plugins/omo-local.ts` pointing at the local dist. Every run
is a separate `opencode run --standalone` process, so a later run proves what survived on disk.

## Why an index

V2 withholds session enumeration from server plugins: `ctx.session` is a `Pick` of `SessionApi`
without `list` in every released and unreleased build (research: 2.0.11 and 2.0.15 are identical
here), `ctx.rpc` cannot call host methods, and `ctx.storage` is a plugin-namespaced KV. `session_read`
and `session_info` only need one session's messages (the shim serves those from
`ctx.session.context`), but `session_list` and the all-sessions mode of `session_search` need a list.
omo now maintains one: `ctx.storage` persistence (probe-verified earlier) fed by the `prompt` hook and
the `sys`-level event stream, which both carry `sessionID`.

## Observed

Three sessions were created (each `--standalone` run is a fresh server, so this also proves the index
is persisted, not in-process memory):

```
run 3: omo_session_list {"limit":10}
| Session ID                     | Messages | First      | Last       | Agents |
|--------------------------------|----------|------------|------------|--------|
| ses_f2e153021ffe3MHXoxbnDpudae | 2        | 2026-09-24 | 2026-09-24 | none   |
| ses_f2e15552effexBTZBIuNQQKm0Z | 3        | 2026-09-24 | 2026-09-24 | none   |
| ses_f2e1575daffeGhSSsT5el2gYNO | 3        | 2026-09-24 | 2026-09-24 | none   |

run 4: omo_session_search {"query":"FIRST_MARKER_ALPHA"}   (no session_id)
[ses_f2e1575daffeGhSSsT5el2gYNO] msg_... (user)      "Reply with exactly FIRST_MARKER_ALPHA"  Matches: 1
[ses_f2e1575daffeGhSSsT5el2gYNO] msg_... (assistant) FIRST_MARKER_ALPHA

run 5: omo_session_info {"session_id":"ses_f2e153021ffe3MHXoxbnDpudae"}
Session ID: ses_f2e153021ffe3MHXoxbnDpudae
Messages: 5
Date Range: 2026-09-24T05:37:03.734Z to 2026-09-24T05:37:13.889Z
Agents Used: none
Has Todos: No
Has Transcript: Yes (3 entries)
```

Tool registration moved from `{"registered":10,"skipped":4,...}` to
`{"registered":13,"skipped":1,"skippedTools":["skill"]}` — only the `skill` tool is still held back,
and that is the permission-hook item, not a session one.

Raw artifact: `live-session-index.log`.

## Honest limits

- The index only knows sessions omo observed after it loaded. Sessions created before the plugin was
  active, or with the plugin disabled, are absent, and there is no backfill without an enumeration
  API. `session_list` therefore returns "No sessions found" on a fresh install rather than lying.
- A **TUI companion plugin** is the only shipped path to a complete list
  (`context.data.session.list()`, `context.client`), recorded in the parity plan as the exact-parity
  option.
- Entries are capped (`SESSION_INDEX_MAX_ENTRIES = 400`), writes are coalesced (1.5s), titles come
  from `ctx.session.get` off the hook path, and `created` is sticky while `updated` only moves
  forward.
- If `ctx.storage` is missing, the registrar skips and the session tools degrade to the previous
  behaviour (SDK then legacy file layout, which finds nothing on V2) instead of throwing.
