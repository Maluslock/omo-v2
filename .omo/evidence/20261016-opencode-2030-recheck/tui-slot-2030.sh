#!/usr/bin/env bash
# Live QA on opencode 2.0.30 (probe #6 of docs/reference/v2-port-summary.md §8):
# does the TUI half of the port still load and function?
#
# Why: §8's sixth probe asks which client config the host reads and whether the
# plugin loads in the TUI path. "Did the frame render" is a weak assertion, so
# this script also checks a FUNCTIONAL trace of the TUI-side plugin: the sidebar
# mirror heartbeat that the plugin writes every ~2s while the TUI runs.
#
# Assertions:
#   PANEL_RENDERED          the TUI painted a known marker under tmux
#   MIRROR_JSON_FILES       snapshots written under $XDG_DATA_HOME/.../tui-state
#   MIRROR_HAS_FIELDS       a snapshot carries all six mirror fields
#   REG_*                   the omo registration lines for this sandbox run
#   GLOBAL_SERVICE_UNTOUCHED `opencode service set port` stayed inside the sandbox
#   LOG_TUI_LINES           plugin log lines mentioning the tui/sidebar path
#   ISO                     the real DB the sandbox did not touch
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/tui-slot-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUTDIR="$REPO_ROOT/.omo/tmp/tui-slot-2030"
REAL_CONFIG="${REAL_CONFIG:-/home/user/.config/opencode/opencode.json}"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode tmux jq sqlite3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

REALDB="$(oqa_db_path)"
BEFORE_COUNT=0
[ -n "$REALDB" ] && [ -f "$REALDB" ] && BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"

# Absolute, captured BEFORE the sandbox repoints $HOME: the user's live managed
# service state. `opencode service set port` must not disturb it.
GLOBAL_SERVICE_FILE="/home/user/.local/state/opencode/service.json"
GLOBAL_SERVICE_BEFORE="$(python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print("%s pid=%s" % (d.get("url", "?"), d.get("pid", "?")))
except Exception:
    print("absent")' "$GLOBAL_SERVICE_FILE" 2>/dev/null)"

mkdir -p "$OUTDIR"; rm -rf "$OUTDIR"; mkdir -p "$OUTDIR"
oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

python3 - "$REAL_CONFIG" "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json, re, sys
cfg = json.loads(re.sub(r'^\s*//.*$', '', open(sys.argv[1]).read(), flags=re.M))
cfg.pop('plugins', None); cfg.pop('plugin', None)
json.dump(cfg, open(sys.argv[2], 'w'), indent=2)
PY
cat > "$OQA_PROJ/.opencode/plugins/omo-local.ts" <<'TS'
export { default } from "/home/user/omo-v2/dist/index.js"
TS

VER_RAW="$(opencode --version 2>/dev/null | head -1)"
printf 'HOST_VERSION=%s\n' "${VER_RAW:-unknown}"

# The TUI boots through a managed background service on a fixed default port,
# which a pre-existing `opencode serve --service` from an older install may
# already hold. Give the sandbox its own port so the probe tests the plugin
# rather than the port collision.
FREE_PORT="$(oqa_free_port)"
# Sandbox-scoped: oqa_mk_isolated_xdg repointed XDG_CONFIG_HOME, and `opencode
# service set port` writes {"port": N} to $XDG_CONFIG_HOME/opencode/service.json
# (verified: the isolated run leaves no service.json anywhere else and the user's
# live service file is untouched), so this cannot disturb the user's service.
if opencode service set port "$FREE_PORT" >/dev/null 2>&1; then
  printf 'SANDBOX_SERVICE_PORT=%s\n' "$FREE_PORT"
else
  printf 'SANDBOX_SERVICE_PORT=unset\n'
fi
printf 'SANDBOX_SERVICE_STATE=%s\n' "$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("port", "none"))
except Exception:
    print("none")' "$XDG_CONFIG_HOME/opencode/service.json" 2>/dev/null)"
GLOBAL_SERVICE_AFTER="$(python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print("%s pid=%s" % (d.get("url", "?"), d.get("pid", "?")))
except Exception:
    print("absent")' "$GLOBAL_SERVICE_FILE" 2>/dev/null)"
printf 'GLOBAL_SERVICE_BEFORE=%s\nGLOBAL_SERVICE_AFTER=%s\n' "$GLOBAL_SERVICE_BEFORE" "$GLOBAL_SERVICE_AFTER"
if [ "$GLOBAL_SERVICE_BEFORE" = "$GLOBAL_SERVICE_AFTER" ]; then
  printf 'GLOBAL_SERVICE_UNTOUCHED=yes\n'
else
  printf 'GLOBAL_SERVICE_UNTOUCHED=no\n'
fi

SESS="oqa_tui_slot_${$}_${RANDOM}"
BEFORE_PLUGIN_LINES="$(wc -l < "${OMO_LOG_FILE:-/tmp/oh-my-opencode.log}" 2>/dev/null | tr -d ' ')"
OQA_TMUX_SESSIONS+=("$SESS")
tmux new-session -d -s "$SESS" -x 200 -y 50
tmux send-keys -t "$SESS" \
  "HOME='$HOME' OPENCODE_TEST_HOME='$OPENCODE_TEST_HOME' XDG_DATA_HOME='$XDG_DATA_HOME' XDG_CONFIG_HOME='$XDG_CONFIG_HOME' XDG_CACHE_HOME='$XDG_CACHE_HOME' XDG_STATE_HOME='$XDG_STATE_HOME' OPENCODE_CONFIG_DIR='$OPENCODE_CONFIG_DIR' OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 opencode '$OQA_PROJ'" Enter

RENDERED=no
for ((i=0; i<80; i++)); do
  cap="$(tmux capture-pane -t "$SESS" -p 2>/dev/null)"
  if printf '%s' "$cap" | grep -Fq "${VER_RAW:-opencode v}" || printf '%s' "$cap" | grep -Eq "Ask anything|ctrl\+p|Sisyphus|MCP"; then RENDERED=yes; break; fi
  sleep 0.5
done
printf 'PANEL_RENDERED=%s\n' "$RENDERED"
[ "$RENDERED" = yes ] || { printf '%s\n' "$cap" | head -6 >&2; printf 'PANEL_HEAD=%s\n' "$(printf '%s' "$cap" | head -1 | cut -c1-100)"; }

# Let the sidebar mirror heartbeat run a few cycles before asserting on disk.
sleep 18
TMUX_CAP="$(tmux capture-pane -t "$SESS" -p 2>/dev/null)"
printf '%s\n' "$TMUX_CAP" > "$OUTDIR/tui-pane.txt"

MIRROR_DIR="$XDG_DATA_HOME/opencode/storage/oh-my-openagent/tui-state"
MIRROR_FILES=0
[ -d "$MIRROR_DIR" ] && MIRROR_FILES="$(find "$MIRROR_DIR" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
printf 'MIRROR_DIR=%s\n' "$MIRROR_DIR"
printf 'MIRROR_JSON_FILES=%s\n' "$MIRROR_FILES"
if [ "$MIRROR_FILES" -gt 0 ]; then
  SAMPLE="$(find "$MIRROR_DIR" -name '*.json' 2>/dev/null | head -1)"
  cp "$SAMPLE" "$OUTDIR/mirror-sample.json" 2>/dev/null || true
  MIRROR_KEYS="$(python3 -c 'import json,sys;print(",".join(sorted(json.load(open(sys.argv[1])))))' "$SAMPLE" 2>/dev/null)"
  printf 'MIRROR_KEYS=%s\n' "${MIRROR_KEYS:-none}"
  if python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));need=["activeAgents","jobBoard","loop","projectDir","updatedAt","version"];sys.exit(0 if all(k in d for k in need) else 1)' "$SAMPLE" 2>/dev/null; then
    printf 'MIRROR_HAS_FIELDS=yes\n'
  else
    printf 'MIRROR_HAS_FIELDS=no\n'
  fi
else
  printf 'MIRROR_HAS_FIELDS=no\n'
fi

SANDBOX_LOG="$(find "$OQA_XDG_ROOT" -name '*.log' 2>/dev/null | head -1)"
cp "$SANDBOX_LOG" "$OUTDIR/sandbox.log" 2>/dev/null || true
printf 'SANDBOX_LOG=%s\n' "${SANDBOX_LOG:-none}"
# The plugin keeps its own log outside the sandbox; the host log will not carry
# plugin lines. Measure a line delta on the plugin log instead.
PLUGIN_LOG="${OMO_LOG_FILE:-/tmp/oh-my-opencode.log}"
AFTER_PLUGIN_LINES="$(wc -l < "$PLUGIN_LOG" 2>/dev/null | tr -d ' ')"
printf 'PLUGIN_LOG_DELTA=%s\n' "$(( ${AFTER_PLUGIN_LINES:-0} - ${BEFORE_PLUGIN_LINES:-0} ))"
printf 'LOG_TUI_LINES=%s\n' "$(tail -n "$(( ${AFTER_PLUGIN_LINES:-0} - ${BEFORE_PLUGIN_LINES:-0} + 1 ))" "$PLUGIN_LOG" 2>/dev/null | grep -acE "tui-sidebar|sidebar" | head -1)"
tail -n "$(( ${AFTER_PLUGIN_LINES:-0} - ${BEFORE_PLUGIN_LINES:-0} + 1 ))" "$PLUGIN_LOG" 2>/dev/null > "$OUTDIR/plugin-log-window.txt"
printf 'LOG_V2_ANY=%s\n' "$(grep -acE "\[v2\]" "$OUTDIR/plugin-log-window.txt" 2>/dev/null | head -1)"
# The "same registration scan as the standalone run" claim must come from parsed
# lines, not from a human squinting at the log window.
for pair in "agents registered:REG_AGENTS" "tools registered:REG_TOOLS" \
            "hooks registered:REG_HOOKS" "mcps registered:REG_MCPS" \
            "commands registered:REG_COMMANDS" "skills registered:REG_SKILLS"; do
  needle="${pair%%:*}"; label="${pair##*:}"
  printf '%s=%s\n' "$label" "$(grep -a "$needle" "$OUTDIR/plugin-log-window.txt" 2>/dev/null | tail -1 | sed 's/^[^{]*//' | cut -c1-160)"
done

tmux kill-session -t "$SESS" 2>/dev/null || true
sleep 0.5
tmux has-session -t "$SESS" 2>/dev/null && printf 'TMUX_TEARDOWN=failed\n' || printf 'TMUX_TEARDOWN=ok\n'

AFTER_COUNT="$BEFORE_COUNT"
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '')"
fi
printf 'ISO_DB=%s\nISO_BEFORE=%s\nISO_AFTER=%s\n' "${REALDB:-none}" "${BEFORE_COUNT:-?}" "${AFTER_COUNT:-?}"
if [ -z "$BEFORE_COUNT" ] || [ -z "$AFTER_COUNT" ]; then
  printf 'ISO=ISO_UNKNOWN\n'
elif [ "$AFTER_COUNT" = "$BEFORE_COUNT" ]; then
  printf 'ISO=ISO_OK\n'
else
  printf 'ISO=ISO_LEAK\n'
fi
printf 'ARTIFACTS=%s\n' "$OUTDIR"
