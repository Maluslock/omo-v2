#!/usr/bin/env bash
# Proves the QA harness leaves nothing behind after a probe that leaks a daemon.
#
# Why this exists: the TUI path boots a managed `opencode serve --service` that
# daemonizes (ppid 1) with a sandbox-scoped XDG tree. Before `oqa_cleanup` grew
# `oqa_kill_sandbox_processes`, that daemon outlived the probe and re-created its
# deleted XDG path on the way out, leaving /tmp/oqa-xdg.* directories behind and a
# stray service process running.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/verify-cleanup-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
export PATH="$REPO_ROOT/.omo/tmp/qa-bin:$HOME/.bun/bin:$PATH"

sandboxes() { ls -d /tmp/oqa-xdg.* 2>/dev/null | wc -l | tr -d ' '; }

# Every `opencode ... serve ... --service` process whose environment still points
# at a sandbox tree. The pattern is assembled at runtime so this script's own
# command line cannot match itself.
sandbox_services() {
  local p id cl env n=0 pat="serve --service"
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    id="${p#/proc/}"
    [ "$id" = "$$" ] && continue
    [ "$id" = "$PPID" ] && continue
    cl="$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null)" || continue
    case "$cl" in *"$pat"*) ;; *) continue ;; esac
    env="$(tr '\0' '\n' <"$p/environ" 2>/dev/null)" || continue
    case "$env" in *oqa-xdg*) n=$((n + 1)) ;; esac
  done
  printf '%s' "$n"
}

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
BEFORE_SB="$(sandboxes)"
BEFORE_SVC="$(sandbox_services)"
printf 'SANDBOXES_BEFORE=%s\nSANDBOX_SCOPED_SERVICES_BEFORE=%s\n' "$BEFORE_SB" "$BEFORE_SVC"

bash "$SCRIPT_DIR/tui-slot-2030.sh" >"$SCRIPT_DIR/out/probe6-tui-slot.txt" 2>&1
RC=$?
# The daemon is killed inside the probe's EXIT trap; give the kernel a moment.
sleep 2
AFTER_SB="$(sandboxes)"
AFTER_SVC="$(sandbox_services)"
printf 'PROBE_RC=%s\nSANDBOXES_AFTER=%s\nSANDBOX_SCOPED_SERVICES_AFTER=%s\n' "$RC" "$AFTER_SB" "$AFTER_SVC"

if [ "$AFTER_SB" = "$BEFORE_SB" ] && [ "$AFTER_SVC" = "$BEFORE_SVC" ]; then
  printf 'CLEANUP=OK (no sandbox directory and no sandbox-scoped service survived)\n'
else
  printf 'CLEANUP=LEAK\n'
fi
