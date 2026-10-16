#!/usr/bin/env bash
# Live QA: does the omo V2 adapter still load and work on the upgraded host?
#
# Written when the local opencode install was moved 2.0.11 -> 2.0.30. The
# question this answers is behavioural, not syntactic: with the user's REAL
# opencode.json (plugins array stripped, the local build wired in through a
# project-local plugin file), does a normal turn still register the same
# agents/tools/hooks/mcps/commands/skills and complete a real tool call?
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/recheck-host.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PLUGIN_FILE="$REPO_ROOT/dist/index.js"
LOG_FILE="${TMPDIR:-/tmp}/oh-my-opencode.log"
REAL_CONFIG="$HOME/.config/opencode/opencode.json"
MODEL="${MODEL:-deepseek/deepseek-v4-pro}"
PROMPT='Use omo_glob to list *.json in the current directory, then reply with exactly SMOKE_OK and the number of matches.'

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
trap - EXIT

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR

if ! oqa_require opencode sqlite3 python3 >/dev/null 2>&1; then
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

# Start from the real config so the feature set under test is the real one, but
# drop the plugin array: it points at the published package, and the local build
# is the thing under test.
python3 - "$REAL_CONFIG" "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
text = re.sub(r'^\s*//.*$', '', open(src).read(), flags=re.M)
cfg = json.loads(text)
cfg.pop('plugins', None)
cfg.pop('plugin', None)
json.dump(cfg, open(dst, 'w'), indent=2)
PY

# The documented working shape: a project-local plugin file re-exporting the build.
printf 'export { default } from "%s"\n' "$PLUGIN_FILE" >"$OQA_PROJ/.opencode/plugins/omo-local.ts"
printf '{"name":"recheck-2030"}\n' >"$OQA_PROJ/package.json"
printf '{}\n' >"$OQA_PROJ/seed.json"

LOG_BEFORE=0
if [ -f "$LOG_FILE" ]; then LOG_BEFORE="$(wc -l <"$LOG_FILE" | tr -d '[:space:]')"; fi

RUN_OUT="$OQA_PROJ/run.jsonl"
RUN_ERR="$OQA_PROJ/run.err"
(cd "$OQA_PROJ" && timeout 180 opencode run --standalone --format json --model "$MODEL" "$PROMPT" >"$RUN_OUT" 2>"$RUN_ERR")
RUN_RC=$?

LOG_AFTER=0
if [ -f "$LOG_FILE" ]; then LOG_AFTER="$(wc -l <"$LOG_FILE" | tr -d '[:space:]')"; fi
WINDOW_FILE="$OQA_PROJ/log-window.txt"
if [ "$LOG_AFTER" -gt "$LOG_BEFORE" ]; then
  tail -n "+$((LOG_BEFORE + 1))" "$LOG_FILE" >"$WINDOW_FILE" 2>/dev/null || : >"$WINDOW_FILE"
else
  : >"$WINDOW_FILE"
fi

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
printf 'MODEL=%s\n' "$MODEL"
printf 'RUN_RC=%s\n' "$RUN_RC"
printf 'LOG_DELTA=%s\n' "$((LOG_AFTER - LOG_BEFORE))"

for KEY in agents tools hooks mcps commands skills; do
  LINE="$(grep -a "\[v2\] $KEY registered" "$WINDOW_FILE" 2>/dev/null | tail -1)"
  printf 'REG_%s=%s\n' "$(printf '%s' "$KEY" | tr '[:lower:]' '[:upper:]')" "${LINE:-MISSING}"
done

python3 - "$RUN_OUT" "$WINDOW_FILE" <<'PY'
import json, sys, re
out, win = sys.argv[1], sys.argv[2]
tool, final, tool_err = None, None, 0
for line in open(out, errors='replace'):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    blob = json.dumps(ev)
    if 'omo_glob' in blob and tool is None:
        tool = blob[:300]
    for key in ('text', 'content'):
        v = ev.get(key)
        if isinstance(v, str) and v.strip():
            final = v.strip()[:200]
    # --format json nests the assistant text under `part`.
    sources = [ev]
    for key in ('part', 'data'):
        if isinstance(ev.get(key), dict):
            sources.append(ev[key])
    for src in sources:
        for key in ('text', 'content'):
            v = src.get(key)
            if isinstance(v, str) and v.strip():
                final = v.strip()[:200]
print('TOOL_CALL=%s' % ('omo_glob:present' if tool else 'omo_glob:missing'))
if tool:
    print('TOOL_EVIDENCE=%s' % tool.replace('\n', ' '))
print('FINAL_TEXT=%s' % (final or 'MISSING'))
errors = 0
for line in open(win, errors='replace'):
    if re.search(r'\[error\]|hook execution failed|unhandled rejection|TypeError|is not a function', line, re.I):
        errors += 1
print('ERROR_LINES=%d' % errors)
PY

AFTER_COUNT="$BEFORE_COUNT"
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi
if [ "$AFTER_COUNT" = "$BEFORE_COUNT" ]; then printf 'ISO=ISO_OK\n'; else printf 'ISO=ISO_LEAK\n'; fi

if [ ! -s "$RUN_OUT" ]; then
  printf 'RUN_STDOUT_EMPTY=1\n'
  printf 'RUN_ERR_TAIL=%s\n' "$(tail -5 "$RUN_ERR" 2>/dev/null | tr '\n' ' ' | cut -c1-400)"
fi
printf 'SANDBOX=%s\n' "$OQA_PROJ"
printf 'LOG_WINDOW=%s\n' "$WINDOW_FILE"
