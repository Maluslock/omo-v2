# V2 plugin storage and event stream — live probe (2026-09-24)

Probe: omo-free, XDG-isolated `opencode serve` + a plugin that writes a key to `ctx.storage`,
subscribes to `ctx.event.subscribe({})`, then receives one prompt. Source:
`live-v2-storage-events-probe.ts`; raw dump: `live-v2-storage-events.jsonl`.

## Why

`session_list` / `session_search` / `session_info` cannot enumerate sessions through the V2 server
plugin API in any released version (source-verified by the research in
`research/REPORT.md`: 2.0.11 and 2.0.15 are identical here, and `ctx.rpc` is not a generic host
proxy). The only in-API alternative is for omo to keep its own session index. That requires two
properties: plugin storage must survive restarts, and the event stream must reveal session ids.

## Observed

1. **Storage persists across server restarts.** Two servers were started against the same isolated
   XDG data dir. First run: `storage.get("session-index")` -> `null`, then `set`. Second run (new
   process): `storage.get("session-index")` ->
   `{"marker":"written","at":1790221265985}`.
2. **`ctx.storage` is a plain KV** (`get/set/remove/scan`). Note: `scan({})` returned
   `{"entries":[]}` immediately after a successful `set`, so scan has options (prefix?) or is
   eventually consistent; an index must therefore be a single key or use explicit prefixes.
3. **`ctx.event.subscribe({})` yields an async iterable of flat events**
   `{id, created, type, durable, location{directory}, data}`. Session-scoped types seen during one
   prompt: `session.inbox.enqueued`, `session.inbox.delivered`, `session.execution.started`,
   `session.step.started`, `session.instructions.updated`, `session.retry.scheduled`; the payloads
   carry `sessionID`. There is no `session.created`/`session.updated` in this stream.
4. **Runtime domain keys**: `storage: get/set/remove/scan`, `event: subscribe`, `rpc: register`
   (no `call`), `generate: text`.

## Consequence for the plan

A storage-backed index is feasible: on `session.hook("prompt")` and on the session-scoped events,
upsert `{id, directory, title, updated}` (title/agent come from `ctx.session.get`), then implement
`session_list` (filter by project path / date), `session_search` (iterate indexed ids and read their
messages through the shim path that `session_read` already uses) and `session_info` (index +
`ctx.session.get`).

Honest limitation: the index starts when omo loads, so sessions created before that are absent, and
there is no backfill without enumeration. Exact/backfilled enumeration is only available in a **TUI**
plugin (`context.data.session.list()`, `context.client`), which the research verified ships in the
installed 2.0.11.
