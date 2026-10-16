#!/usr/bin/env bash
# Live QA: is `session.created` still emitted on the raw 2.0.30 event wire?
#
# Why: the plugin-side catalog capture (event-catalog-2030.sh) never saw
# `session.created` on 2.0.30, while the 2.0.11 baseline did - and six V1 hooks
# key off that name (auto-update-checker, codegraph bootstrap, ast-grep sg
# provisioning, runtime-fallback, legacy-plugin-toast, session-notification).
# This probe bypasses our plugin entirely: it watches the server's own SSE
# stream (GET /api/event) across a session creation, so "the host stopped
# emitting it" and "our subscription misses it" cannot be confused.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/raw-event-stream-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUTDIR="$REPO_ROOT/.omo/tmp/event-catalog-2030"
STREAM="$OUTDIR/raw-sse.txt"
REAL_CONFIG="${REAL_CONFIG:-/home/user/.config/opencode/opencode.json}"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 curl jq python3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

REALDB="$(oqa_db_path)"
BEFORE_COUNT=0
[ -n "$REALDB" ] && [ -f "$REALDB" ] && BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"

mkdir -p "$OUTDIR"; rm -f "$STREAM"
oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ"

python3 - "$REAL_CONFIG" "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json, re, sys
cfg = json.loads(re.sub(r'^\s*//.*$', '', open(sys.argv[1]).read(), flags=re.M))
cfg.pop('plugins', None); cfg.pop('plugin', None)
json.dump(cfg, open(sys.argv[2], 'w'), indent=2)
PY

PORT="$(oqa_free_port)"; PASS="oqa-${RANDOM}${RANDOM}"
(cd "$OQA_PROJ" && OPENCODE_SERVER_PASSWORD="$PASS" opencode serve --port "$PORT" --hostname 127.0.0.1 \
  >"$OQA_PROJ/serve.out" 2>"$OQA_PROJ/serve.err") &
OQA_SERVER_PID=$!
disown "$OQA_SERVER_PID" 2>/dev/null || true
URL="http://127.0.0.1:$PORT"
printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"

if ! oqa_wait_http "$URL/global/health" "opencode:$PASS" 40; then printf 'ERROR=serve_start_failed\n'; exit 1; fi

curl -sN -u "opencode:$PASS" "$URL/api/event" >"$STREAM" 2>"$OUTDIR/raw-sse.err" &
CURL_PID=$!
OQA_CURL_PIDS+=("$CURL_PID")
sleep 3

ENC="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$OQA_PROJ")"
SES_RAW="$(curl -sS -u "opencode:$PASS" -X POST "$URL/api/session?directory=$ENC" \
  -H 'content-type: application/json' -d '{"title":"raw event probe"}' 2>/dev/null)"
SES="$(printf '%s' "$SES_RAW" | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null)"
printf 'SESSION=%s\n' "${SES:-CREATE_FAILED}"
printf 'CREATE_RAW=%s\n' "$(printf '%s' "$SES_RAW" | head -c 200)"

sleep 4
kill "$CURL_PID" 2>/dev/null || true
OQA_CURL_PIDS=()

python3 - "$STREAM" <<'PY'
import re, sys, json
types = set()
raw = open(sys.argv[1], errors='replace').read()
for line in raw.splitlines():
    line = line.strip()
    if line.startswith('data:'):
        try:
            ev = json.loads(line[5:].strip())
        except Exception:
            continue
        t = ev.get('type')
        if t:
            types.add(t)
print('WIRE_EVENT_TYPES=%d' % len(types))
print('WIRE_HAS_SESSION_CREATED=%s' % ('yes' if 'session.created' in types else 'no'))
print('WIRE_SESSION_EVENTS=%s' % ','.join(sorted(t for t in types if t.startswith('session.'))))
PY

cp "$OQA_PROJ/serve.err" "$OUTDIR/serve.err" 2>/dev/null || true
printf 'STREAM_BYTES=%s\n' "$(wc -c <"$STREAM" 2>/dev/null | tr -d '[:space:]')"
printf 'STREAM=%s\n' "$STREAM"

kill "$OQA_SERVER_PID" 2>/dev/null || true
OQA_SERVER_PID=""
AFTER_COUNT="$BEFORE_COUNT"
[ -n "$REALDB" ] && [ -f "$REALDB" ] && AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
[ "$AFTER_COUNT" = "$BEFORE_COUNT" ] && printf 'ISO=ISO_OK\n' || printf 'ISO=ISO_LEAK\n'
