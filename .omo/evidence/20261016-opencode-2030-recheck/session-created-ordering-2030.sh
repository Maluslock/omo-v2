#!/usr/bin/env bash
# Live QA: when does a plugin's event subscription start on opencode 2.0.30?
#
# Why: the plugin-side catalog capture never saw `session.created`, yet the raw
# SSE wire carries it and the event pipeline (host.event.subscribe -> encode
# against the OpenCodeEvent union) is byte-identical to 2.0.11, where the
# baseline capture DID see it. The remaining explanation is ordering: if the
# plugin's `setup()` (and therefore its subscription) only runs on first use,
# then a session created before any prompt is missed, while a session created
# after the plugin is awake is seen.
#
# Method: in the serve topology, create+prompt session A, then create+prompt
# session B, and report which sessions' `session.created` reached the plugin.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/session-created-ordering-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROBE_SRC="$SCRIPT_DIR/event-catalog-probe-2030.ts"
OUTDIR="$REPO_ROOT/.omo/tmp/event-catalog-2030"
DUMP="$OUTDIR/ordering-dump.jsonl"
REAL_CONFIG="${REAL_CONFIG:-/home/user/.config/opencode/opencode.json}"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 curl jq python3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

REALDB="$(oqa_db_path)"
BEFORE_COUNT=0
[ -n "$REALDB" ] && [ -f "$REALDB" ] && BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"

mkdir -p "$OUTDIR"; rm -f "$DUMP"
oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

python3 - "$REAL_CONFIG" "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json, re, sys
cfg = json.loads(re.sub(r'^\s*//.*$', '', open(sys.argv[1]).read(), flags=re.M))
cfg.pop('plugins', None); cfg.pop('plugin', None)
json.dump(cfg, open(sys.argv[2], 'w'), indent=2)
PY
cp "$PROBE_SRC" "$OQA_PROJ/.opencode/plugins/zz-events-2030.ts"

PORT="$(oqa_free_port)"; PASS="oqa-${RANDOM}${RANDOM}"
# `exec` matters: without it $! is the subshell, so the kill below would leave
# the real server orphaned (ppid 1) and holding its port.
(cd "$OQA_PROJ" && exec env CATALOG_OUT="$DUMP" OPENCODE_SERVER_PASSWORD="$PASS" opencode serve --port "$PORT" --hostname 127.0.0.1 \
  >"$OQA_PROJ/serve.out" 2>"$OQA_PROJ/serve.err") &
OQA_SERVER_PID=$!
disown "$OQA_SERVER_PID" 2>/dev/null || true
URL="http://127.0.0.1:$PORT"
printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
if ! oqa_wait_http "$URL/global/health" "opencode:$PASS" 40; then printf 'ERROR=serve_start_failed\n'; exit 1; fi

ENC="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$OQA_PROJ")"

create_session() {
  curl -sS -u "opencode:$PASS" -X POST "$URL/api/session?directory=$ENC" \
    -H 'content-type: application/json' -d "{\"title\":\"$1\"}" 2>/dev/null \
    | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null
}
prompt_session() {
  curl -sS -u "opencode:$PASS" -o /dev/null -X POST "$URL/api/session/$1/prompt?directory=$ENC" \
    -H 'content-type: application/json' -d '{"text":"Reply with exactly ORDER_OK"}' 2>/dev/null
}
wait_done() {
  local deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(grep -c '"session.execution.succeeded"' "$DUMP" 2>/dev/null | head -1)" -ge "$1" ] && return 0
    sleep 2
  done
  return 1
}

# A and B are both created before the plugin is prompted even once, so this
# distinguishes "only the very first session is missed" (A=no, B=yes) from
# "every session created before the plugin's first prompt is missed"
# (A=no, B=no), with C created after the first prompt as the control.
SES_A="$(create_session "ordering A")"
SES_B="$(create_session "ordering B")"
printf 'SESSION_A=%s\n' "${SES_A:-CREATE_FAILED}"
printf 'SESSION_B=%s\n' "${SES_B:-CREATE_FAILED}"
prompt_session "$SES_A"
wait_done 1 || printf 'WARN=session_A_never_finished\n'
prompt_session "$SES_B"
wait_done 2 || printf 'WARN=session_B_never_finished\n'

SES_C="$(create_session "ordering C")"
printf 'SESSION_C=%s\n' "${SES_C:-CREATE_FAILED}"
prompt_session "$SES_C"
wait_done 3 || printf 'WARN=session_C_never_finished\n'

python3 - "$DUMP" "$SES_A" "$SES_B" "$SES_C" <<'PY'
import json, sys
dump, a, b, c = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
rows = []
try:
    for line in open(dump, errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            p = (json.loads(line).get('payload') or {})
        except Exception:
            continue
        rows.append(p)
except FileNotFoundError:
    pass
created = [p.get('sessionID') for p in rows if p.get('type') == 'session.created']
executed = [p.get('sessionID') for p in rows if p.get('type') == 'session.execution.succeeded']
print('EVENTS_TOTAL=%d' % len(rows))
print('SESSION_CREATED_COUNT=%d' % len(created))
print('SESSION_CREATED_IDS=%s' % ','.join(x or '?' for x in created))
print('EXECUTION_SUCCEEDED_IDS=%s' % ','.join(x or '?' for x in executed))
print('CREATED_SAW_A=%s' % ('yes' if a in created else 'no'))
print('CREATED_SAW_B=%s' % ('yes' if b in created else 'no'))
print('CREATED_SAW_C=%s' % ('yes' if c in created else 'no'))
print('SUCCEEDED_SAW_A=%s' % ('yes' if a in executed else 'no'))
print('SUCCEEDED_SAW_B=%s' % ('yes' if b in executed else 'no'))
print('SUCCEEDED_SAW_C=%s' % ('yes' if c in executed else 'no'))
print('WINDOW=%s' % ('first_session_only' if (a not in created and b in created)
                     else 'pre_first_prompt_window' if (a not in created and b not in created)
                     else 'everything_seen'))
PY

cp "$OQA_PROJ/serve.err" "$OUTDIR/serve-ordering.err" 2>/dev/null || true
printf 'DUMP=%s\n' "$DUMP"
kill "$OQA_SERVER_PID" 2>/dev/null || true
OQA_SERVER_PID=""
AFTER_COUNT="$BEFORE_COUNT"
[ -n "$REALDB" ] && [ -f "$REALDB" ] && AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
[ "$AFTER_COUNT" = "$BEFORE_COUNT" ] && printf 'ISO=ISO_OK\n' || printf 'ISO=ISO_LEAK\n'
