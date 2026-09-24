# Session enumeration backfill from the host store (P6-B1 path B superseded, 2026-09-24)

## Why

`session_list` / `session_search` enumerate sessions through omo's own index (committed earlier this
session), which only exists from the moment omo loads. Sessions created before that - by another
client, by a host run without omo, or simply before a restart on a host whose index was cleared - are
invisible. Measured earlier as "0 sessions" on V2.

The plan's path B was a **TUI companion plugin** (`context.data.session.list()` is available to TUI
plugins in 2.0.11). Two problems make that the wrong tool:

1. It only works while a TUI is open. `opencode run`, `opencode serve`, the web UI and headless agent
   runs have no TUI, so `session_list` would stay empty exactly where agents use it most.
2. The TUI side is not even loaded on this host: `~/.config/opencode/tui.json` points at
   `oh-my-openagent@latest`, whose V1 `{id, server}` shape 2.0.11 rejects, while the working local
   entry (`plugins/omo-local.ts`) lives in the server plugin directory.

The host keeps every session in `<data dir>/opencode/opencode.db` (`session_v2`), and omo already
reads the host's session storage directly for the legacy layout (`file-storage.ts`). Reading the
SQLite layout the same way is strictly simpler and works headless.

## What changed

- `tools/session-manager/sqlite-storage.ts` (new): a read-only reader for `session_v2`.
  - `getSqliteMainSessions(directory?)` mirrors `getFileMainSessions`: top-level rows only, newest
    first, optional project filter.
  - `getSqliteAllSessionIds()` feeds `session_search`; `sqliteSessionExists(id)` lets
    `session_read` resolve a session that has no message directory on disk.
  - Opened `{ readonly: true }`, so it can never write the host's store.
  - `bun:sqlite` is imported **dynamically**, and only from `bun-sqlite-shim.ts`: the V2 host is a Bun
    single-file executable, but a Node runtime or a future schema must degrade to "no backfill"
    instead of crashing. The audit below forced the split.
  - Every failure (missing file, missing table, corrupt file, non-Bun runtime) logs once and returns
    an empty result, so the live index and the file layout keep working.
  - `OMO_SESSION_DB_PATH` overrides the path (non-standard layouts, hermetic tests).
- `tools/session-manager/bun-sqlite-shim.ts` (new): the one file allowed to touch `bun:sqlite`.
  `opencode-adapter-bun-runtime-audit.test.ts` failed the first version of this change because the
  dynamic import lived in `sqlite-storage.ts`; the audit exempts `bun-*-shim.ts` by design, so the
  module access moved there and the reader stays runtime-agnostic. Worth knowing: the repo gate
  catches this, and the correct move is always the shim file, never a loosened audit.
- `tools/session-manager/storage.ts`: `getMainSessions` / `getAllSessions` merge the backfill with
  the live sources through a new `mergeSessionMetadataSources`, documented highest-precedence-first
  (live index > file layout > backfill). `sessionExists` consults the store as a last resort.
- `test-setup.ts`: points `OMO_SESSION_DB_PATH` inside the existing hermetic temp HOME, so no suite
  can see the developer's real sessions (the reader resolves through `os.homedir()`, which ignores
  the hermetic `HOME` the harness already sets - the same trap its comment documents for discovery).
- Tests: `sqlite-storage.test.ts` (9 cases) and `storage-backfill.test.ts` (6 cases).

## Unit verification

```
bun test packages/omo-opencode/src/tools/session-manager/
 79 pass, 0 fail
bun test packages/omo-opencode/src/shared/opencode-adapter-bun-runtime-audit.test.ts
 pass
```

The sqlite suite builds real databases in a temp dir: newest-first ordering, child sessions excluded
from "main" but included in ids, directory filter, rows missing fields dropped, and the three
degradation paths (no file, no table, corrupt file). The backfill suite pins the merge: the live
index wins for a shared id, backfill-only ids are added, ids union, `sessionExists` resolves a
store-only session, and an absent store adds nothing.

A test caught a real SQL bug while writing this: `where parent_id is null or parent_id = '' and
directory = ?` binds as `parent_id is null OR (parent_id = '' AND directory = ?)`, so the directory
filter silently did not apply to top-level rows. The condition is now parenthesized.

## Live verification, before / after

Scenario (isolated sandbox, fresh XDG roots): a session is created **with omo not loaded at all**
(`opencode run --title PRE_OMO_SESSION`), the database is snapshotted, and then omo is loaded from the
local dist for a second run that calls `omo_session_list` on the same project. Each run restores the
snapshot, so both see exactly one pre-existing session.

```
BEFORE (dist built from 48cee04, without the backfill; transcript run-before.json)
  omo_session_list -> | ses_f2d7743e3ffeMT5oP4VQvMBeA8 | 2 | ... |
  final text       -> COUNT=1  PRE=no
  (the only row is the probe's own session; the pre-existing one is invisible)

AFTER (same sandbox snapshot, backfill built in; transcript run-after2.json)
  omo_session_list -> | ses_f2d7a53a3ffeD73eGFkCT4DsRy | 2 | ... |
                      | ses_f2d82330fffeE5ZK6xo0VdQOpA | 3 | ... |
  final text       -> COUNT=2  PRE=yes
```

`ses_f2d82330fffeE5ZK6xo0VdQOpA` is the pre-existing session, the same id in both runs because the
snapshot is restored before each: a direct read-only query of the snapshot shows exactly
`{id: ses_f2d82330fffeE5ZK6xo0VdQOpA, title: "PRE_OMO_SESSION", directory: <probe project>}`.

In the after run the agent also went beyond the prompt (it has the full tool set) and read that
session back:

```
[omo_session_info] Session ID: ses_f2d82330fffeE5ZK6xo0VdQOpA  Messages: 3
[omo_session_read] [user] 2026-09-24T08:17:35.829Z  "Reply with exactly PRE_SESSION_CREATED"
[omo_session_search] Found 2 matches:
  [ses_f2d82330fffeE5ZK6xo0VdQOpA] (user)  "Reply with exactly PRE_SESSION_CREATED"   Matches: 1
  [ses_f2d82330fffeE5ZK6xo0VdQOpA] (assistant)  PRE_SESSION_CREATED                  Matches: 1
```

So a backfilled session is enumerable, searchable and readable, which is the whole feature
(`session_read` resolves it through `sessionExists` -> `readSessionMessages` even though it has no
message directory on disk).

Raw transcripts: `.omo/tmp/backfill-probe/run-before.json`, `run-after2.json` (list),
`run-after-info.json`, `run-search.json`; runner `.omo/tmp/backfill-probe/run-probe.sh`; baseline
snapshot `.omo/tmp/backfill-probe/base.db*`.

## Findings worth keeping

- **WAL reads work.** The sandbox store is WAL-mode and its rows live in `opencode.db-wal` until
  checkpoint; a read-only connection still sees them (the first snapshot attempt that copied only
  `.db` silently lost the session, which is how this was noticed). The real host's store is 1.9 GB and
  also WAL-mode; `readonly: true` reads it without touching it.
- `session_list` and `session_info` do not print a session **title**. That is pre-existing formatter
  behaviour, not a backfill issue, and it is why the live prompt could not answer "does a title
  contain X" - the id match against the snapshot is the proof instead.

## Regression check

Full `bun test`: 12943 pass / 3 skip / 13 fail - the same 13 pre-existing failures.

## Why this is enough

- The defect is user-visible and reproduced: one pre-existing session, invisible before, listed and
  searchable after, with the id verified against the store directly.
- The reader has no write path and every failure mode is a tested no-op, so the worst case on an
  unknown host is the previous behaviour.
- The merge precedence is pinned by unit tests, so "live wins over backfill" cannot silently invert.

## What was omitted

Probe content is synthetic (`PRE_SESSION_CREATED`, `PRE_OMO_SESSION`); no real session text, titles
from the user's host, or credentials are recorded. The real database is never written.

## Residual risk

- The reader couples to the host's `session_v2` schema. A rename or a move to another store degrades
  to "no backfill" (logged once), never to a wrong answer or a crash; the live index still works.
- `getMainSessions`/`getAllSessions` now open the store on every call, including on V1 hosts where
  the SDK already enumerates. The query is a scan of a table with one row per session, so the cost is
  bounded, but it is new work on the V1 path.
- `session_search` now walks backfilled ids as well, so a search scans more sessions than before -
  the same set V1 enumerated through its SDK.
