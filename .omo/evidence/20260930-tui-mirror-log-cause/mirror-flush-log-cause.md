# A failed TUI-mirror flush now records its cause

**Date:** 2026-09-30 | **Host:** `opencode` v2.0.11 (`~/.local/share/opencode2`) | **Change:**
`packages/omo-opencode/src/features/tui-sidebar/mirror-manager.ts`

## What was tested

The sidebar mirror is written by the server plugin and read back by the TUI plugin. When that write
fails, the reporter logged the raw `Error`, which JSON-serializes to `{}`. The real log proves it:

```
$ grep -n 'mirror flush failed' /tmp/oh-my-opencode.log | tail -1
126737:[2026-09-28T03:47:04.836Z] [tui-sidebar] mirror flush failed {"error":{}}
```

All seven such lines (2026-09-28T03:46:58 to 03:47:04) carry no cause, so the failure could not be
diagnosed from the log at all. The default reporter now logs `projectDir` plus the error `message`,
`code` and `stack` via the new pure helper `flushErrorFields()`.

Surface driven: the real 2.x CLI in an isolated XDG sandbox, with the plugin loaded through the
documented project-local shape and the mirror directory made unwritable so the failure path runs.

```bash
export PATH="$PWD/.omo/tmp/qa-bin:$HOME/.bun/bin:$PATH"   # scratch symlink to opencode 2.0.11
bash packages/omo-opencode/src/features/tui-sidebar/qa/mirror-failure-log.sh
```

## What was observed

```
MIRROR_DIR=/tmp/oqa-xdg.me1MGE/data/opencode/storage/oh-my-openagent/tui-state
PROJECT=/tmp/oqa-xdg.me1MGE/proj
RUN_RC=0
LOG_DELTA=24
FLUSH_FAIL_LINES=1
OPAQUE_LINES=0
LAST_LINE=[2026-09-30T02:55:57.370Z] [tui-sidebar] mirror flush failed {"projectDir":"/tmp/oqa-xdg.me1MGE/proj","message":"EACCES: permission denied, open '/tmp/oqa-xdg.me1MGE/data/opencode/storage/oh-my-openagent/tui-state/33e78cbbc9c8c480.json.tmp'","stack":"Error: EACCES: permission denied, open '...json.tmp'\n    at writeF
ISO=ISO_OK
LOG=LOG_HAS_CAUSE
```

- The failure path fired exactly once and the record names the project, the errno message and the
  temp path, which is what the `{}` record hid.
- `OPAQUE_LINES=0`: no `{"error":{}}` record appeared in the measured window.
- `ISO=ISO_OK`: `SELECT count(*) FROM session` on the real store was identical before and after, so
  the probe wrote nothing into `~/.local/share/opencode`. The log window was measured by line delta
  (baseline 129868 lines) because the suite and other hosts share `/tmp/oh-my-opencode.log`.
- Unit gate: `bun test .../mirror-manager.test.ts` reports 8 pass / 0 fail, including the two new
  `flushErrorFields` cases.

## Why it is enough

The probe drives the real host, forces the real failure, and asserts on the log line the operator
would actually read, so it proves both that the path still runs and that the record is usable. The
new unit cases pin the field shape without touching the filesystem.

This also characterizes the original failure: the error is an `EACCES` opening the `.tmp` sibling,
which is why single `.json.tmp` orphans exist in the real mirror directory. `writeFileAtomically`
rewrites that temp path on the next flush, so the orphan is cosmetic; the missing cause in the log
was the real gap.

## What was omitted

The full `stack` field is truncated here to keep the line readable; it contains only the plugin's own
frames plus sandbox paths. No credentials, tokens or real user paths beyond the sandbox are recorded.
The real store was never written, only counted.

## Probe correction

The first probe run asserted `ERROR=flush_failure_path_never_fired` with `RUN_RC=124`, `LOG_DELTA=0`.
Cause: it declared the plugin through the `opencode.json` `plugin` array, which 2.0.11 does not use for
a local path, so the plugin never loaded. Switching to the project-local
`.opencode/plugins/omo-local.ts` re-export plus `--standalone` made the run complete (`RUN_RC=0`). The
failed run is kept here because the empty stdout/stderr is itself the tell.
