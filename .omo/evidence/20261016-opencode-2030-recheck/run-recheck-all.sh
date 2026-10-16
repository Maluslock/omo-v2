#!/usr/bin/env bash
# Orchestrates the 2.0.30 recheck probe suite so every PASS has a committed
# capture in .omo/evidence/20261016-opencode-2030-recheck/out/.
#
# Ordering matters in one place: probe 1 (omo itself) and probe 6 (TUI + omo)
# both measure a line delta on the shared plugin log /tmp/oh-my-opencode.log, so
# they run alone, after the probe-plugin-only runs have finished.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/run-recheck-all.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
REPO_ROOT="$(git rev-parse --show-toplevel)"
export PATH="$REPO_ROOT/.omo/tmp/qa-bin:$HOME/.bun/bin:$PATH"
mkdir -p out
progress="${PROGRESS:-$REPO_ROOT/.omo/tmp/run-recheck-all.progress}"
: >"$progress"
say() { printf '%s %s\n' "$(date -Is)" "$*" >>"$progress"; }

# Janitor baseline: sandboxes that already existed before this run stay untouched.
PRE_EXISTING="$(ls -d /tmp/oqa-xdg.* 2>/dev/null || true)"

say "group1 start: probe2 probe3 probe5"
bash event-catalog-2030.sh      >out/probe2-event-catalog.txt      2>&1 &
p2=$!
bash gen-options-2030.sh        >out/probe3-gen-options.txt        2>&1 &
p3=$!
bash compaction-2030.sh         >out/probe5-compaction.txt         2>&1 &
p5=$!
wait "$p2"; say "probe2 rc=$?"
wait "$p3"; say "probe3 rc=$?"
wait "$p5"; say "probe5 rc=$?"

say "group2 start: probe4 ordering, probe4b subagent liveness, probe5b bad summary, serve catalog, raw wire"
bash session-created-ordering-2030.sh >out/probe4-ordering.txt     2>&1 &
p4=$!
bash subagent-liveness-2030.sh         >out/probe4b-subagent-liveness.txt 2>&1 &
p4b=$!
BAD_SUMMARY=1 bash compaction-2030.sh  >out/probe5b-compaction-failed.txt 2>&1 &
p5b=$!
bash serve-event-catalog-2030.sh       >out/probe-serve-catalog.txt 2>&1 &
psv=$!
bash raw-event-stream-2030.sh          >out/probe-raw-wire.txt      2>&1 &
praw=$!
wait "$p4";   say "probe4 rc=$?"
wait "$p4b";  say "probe4b rc=$?"
wait "$p5b";  say "probe5b rc=$?"
wait "$psv";  say "serve-catalog rc=$?"
wait "$praw"; say "raw-wire rc=$?"

say "group3: probe1 alone (shared plugin log delta)"
bash recheck-host.sh >out/probe1-recheck-host.txt 2>&1
say "probe1 rc=$?"

say "group4: probe6 alone (TUI)"
bash tui-slot-2030.sh >out/probe6-tui-slot.txt 2>&1
say "probe6 rc=$?"

say "schema-diff (static, no host needed)"
bash schema-diff-2030.sh >out/schema-diff.txt 2>&1
say "schema-diff rc=$?"

say "real-db read-only check (static, no sandbox)"
bash real-db-readonly-2030.sh >out/real-db-readonly.txt 2>&1
say "real-db rc=$?"

# Janitor: the library's EXIT trap removes each sandbox, but a straggler child can
# re-create its (already deleted) XDG path on the way out. Settle, then sweep only
# the sandboxes that appeared during this run.
sleep 1
swept=0
for d in /tmp/oqa-xdg.*; do
  [ -d "$d" ] || continue
  case "$PRE_EXISTING" in *"$d"*) continue ;; esac
  rm -rf "$d" && swept=$((swept + 1))
done
say "janitor swept $swept sandbox(es)"

say "done"
