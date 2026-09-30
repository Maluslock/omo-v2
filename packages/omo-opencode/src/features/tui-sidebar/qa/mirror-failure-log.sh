#!/usr/bin/env bash
# Live QA: a failed TUI-mirror flush must record WHY it failed.
#
# Before this change the reporter logged the raw Error object, which JSON-
# serializes to `{"error":{}}` - the real 2026-09-28 log lines carry no cause.
# This probe forces the write to fail (the mirror directory exists but is not
# writable) and asserts the logged record carries a non-empty message.
#
# Usage: bash packages/omo-opencode/src/features/tui-sidebar/qa/mirror-failure-log.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PLUGIN_FILE="$REPO_ROOT/dist/index.js"
LOG_FILE="${TMPDIR:-/tmp}/oh-my-opencode.log"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
trap - EXIT

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR

if ! oqa_require opencode sqlite3 >/dev/null 2>&1; then
  printf 'ERROR=missing_dependency\n'
  exit 1
fi

REALDB="$(oqa_db_path)"
BEFORE_COUNT=0
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi

if ! oqa_mk_isolated_xdg; then
  printf 'ERROR=isolated_xdg_failed\n'
  exit 1
fi

export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

cat >"$OPENCODE_CONFIG_DIR/opencode.json" <<JSON
{
  "model": "opencode/big-pickle"
}
JSON

# 2.0.11 does not load a local path from the opencode.json plugin array; the
# documented working shape is a project-local plugin file re-exporting the build.
printf 'export { default } from "%s"\n' "$PLUGIN_FILE" >"$OQA_PROJ/.opencode/plugins/omo-local.ts"

MIRROR_DIR="$XDG_DATA_HOME/opencode/storage/oh-my-openagent/tui-state"
mkdir -p "$MIRROR_DIR"
chmod 500 "$MIRROR_DIR"

LOG_BEFORE=0
if [ -f "$LOG_FILE" ]; then
  LOG_BEFORE="$(wc -l <"$LOG_FILE" | tr -d '[:space:]')"
fi

RUN_OUT="$OQA_PROJ/run.jsonl"
RUN_ERR="$OQA_PROJ/run.err"
(cd "$OQA_PROJ" && timeout 45 opencode run --standalone --format json "hi" >"$RUN_OUT" 2>"$RUN_ERR")
RUN_RC=$?

if [ ! -s "$RUN_OUT" ]; then
  printf 'RUN_STDOUT_EMPTY=1\n'
  printf 'RUN_ERR_TAIL=%s\n' "$(tail -5 "$RUN_ERR" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

chmod 700 "$MIRROR_DIR" 2>/dev/null || true

LOG_AFTER=0
if [ -f "$LOG_FILE" ]; then
  LOG_AFTER="$(wc -l <"$LOG_FILE" | tr -d '[:space:]')"
fi

WINDOW=""
if [ "$LOG_AFTER" -gt "$LOG_BEFORE" ]; then
  WINDOW="$(tail -n "+$((LOG_BEFORE + 1))" "$LOG_FILE" 2>/dev/null | grep 'mirror flush failed' || true)"
fi

COUNT=0
if [ -n "$WINDOW" ]; then
  COUNT="$(printf '%s\n' "$WINDOW" | grep -c 'mirror flush failed')"
fi
LAST="$(printf '%s\n' "$WINDOW" | tail -1)"
BLANK=0
if [ -n "$WINDOW" ]; then
  BLANK="$(printf '%s\n' "$WINDOW" | grep -c '{"error":{}}' || true)"
fi

FAILED=0
printf 'MIRROR_DIR=%s\n' "$MIRROR_DIR"
printf 'PROJECT=%s\n' "$OQA_PROJ"
printf 'RUN_RC=%s\n' "$RUN_RC"
printf 'LOG_DELTA=%s\n' "$((LOG_AFTER - LOG_BEFORE))"
printf 'FLUSH_FAIL_LINES=%s\n' "$COUNT"
printf 'OPAQUE_LINES=%s\n' "$BLANK"
printf 'LAST_LINE=%s\n' "${LAST:0:400}"

AFTER_COUNT="$BEFORE_COUNT"
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi
if [ "$AFTER_COUNT" = "$BEFORE_COUNT" ]; then
  printf 'ISO=ISO_OK\n'
else
  printf 'ISO=ISO_LEAK\n'
  FAILED=1
fi

if [ "$COUNT" -eq 0 ]; then
  printf 'ERROR=flush_failure_path_never_fired\n'
  FAILED=1
elif printf '%s' "$LAST" | grep -q '"message":"[^"]\+"'; then
  printf 'LOG=LOG_HAS_CAUSE\n'
  if [ "$BLANK" -ne 0 ]; then
    printf 'ERROR=opaque_error_record_also_present\n'
    FAILED=1
  fi
else
  printf 'ERROR=log_record_has_no_message\n'
  FAILED=1
fi

exit "$FAILED"
