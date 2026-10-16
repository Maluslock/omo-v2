#!/usr/bin/env bash
# Live QA: the V2 event vocabulary as a PLUGIN INSIDE THE SERVER sees it on 2.0.30.
#
# Why this exists on top of event-catalog-2030.sh: the standalone `opencode run`
# capture did not deliver `session.created`, while the 2.0.11 baseline did. The
# server topology is the one the user actually runs (a plugin loaded inside
# `opencode serve`, sessions created afterwards by a client), so it settles
# whether that name still reaches plugins or whether the change is a
# subscription-ordering artifact of the CLI path.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/serve-event-catalog-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROBE_SRC="$SCRIPT_DIR/event-catalog-probe-2030.ts"
OUTDIR="$REPO_ROOT/.omo/tmp/event-catalog-2030"
DUMP="$OUTDIR/serve-dump.jsonl"
MODEL="${MODEL:-deepseek/deepseek-v4-pro}"
REAL_CONFIG="${REAL_CONFIG:-/home/user/.config/opencode/opencode.json}"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 curl jq python3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

REALDB="$(oqa_db_path)"
BEFORE_COUNT=0
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi

mkdir -p "$OUTDIR"
rm -f "$DUMP"

oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

python3 - "$REAL_CONFIG" "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
cfg = json.loads(re.sub(r'^\s*//.*$', '', open(src).read(), flags=re.M))
cfg.pop('plugins', None)
cfg.pop('plugin', None)
json.dump(cfg, open(dst, 'w'), indent=2)
PY
cp "$PROBE_SRC" "$OQA_PROJ/.opencode/plugins/zz-events-2030.ts"
printf '{"name":"serve-catalog-2030"}\n' >"$OQA_PROJ/package.json"

PORT="$(oqa_free_port)"
PASS="oqa-${RANDOM}${RANDOM}"
export CATALOG_OUT="$DUMP"
# `exec` matters: without it $! is the subshell, so the kill below would leave
# the real server orphaned (ppid 1) and holding its port.
(cd "$OQA_PROJ" && exec env OPENCODE_SERVER_PASSWORD="$PASS" opencode serve --port "$PORT" --hostname 127.0.0.1 \
  >"$OQA_PROJ/serve.out" 2>"$OQA_PROJ/serve.err") &
OQA_SERVER_PID=$!
disown "$OQA_SERVER_PID" 2>/dev/null || true
export OQA_SERVER_PORT="$PORT" OQA_SERVER_PASS="$PASS" OQA_SERVER_URL="http://127.0.0.1:$PORT"

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
if ! oqa_wait_http "$OQA_SERVER_URL/global/health" "opencode:$PASS" 40; then
  printf 'ERROR=serve_start_failed\n'
  tail -5 "$OQA_PROJ/serve.err" 2>/dev/null
  exit 1
fi
printf 'SERVE=ready\n'

ENC_DIR="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$OQA_PROJ")"
# 2.0.30 moved the HTTP API under /api (2.0.11's POST /session is a 405 here);
# routes read from the server's own /openapi.json, not guessed.
SES_RAW="$(curl -sS -u "opencode:$PASS" -X POST "$OQA_SERVER_URL/api/session?directory=$ENC_DIR" \
  -H 'content-type: application/json' -d '{"title":"event catalog 2030"}' 2>/dev/null)"
SES="$(printf '%s' "$SES_RAW" | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null)"
if [ -z "$SES" ]; then printf 'ERROR=session_create_failed\n'; printf 'CREATE_RAW=%s\n' "${SES_RAW:0:300}"; exit 1; fi
printf 'SESSION=%s\n' "$SES"

PROMPT_CODE="$(curl -sS -u "opencode:$PASS" -o "$OQA_PROJ/prompt.out" -w '%{http_code}' \
  -X POST "$OQA_SERVER_URL/api/session/$SES/prompt?directory=$ENC_DIR" \
  -H 'content-type: application/json' \
  -d '{"text":"Reply with exactly SERVE_DONE"}' 2>"$OQA_PROJ/prompt.err")"
printf 'PROMPT_HTTP=%s\n' "$PROMPT_CODE"
printf 'PROMPT_BODY=%s\n' "$(head -c 300 "$OQA_PROJ/prompt.out" 2>/dev/null | tr '\n' ' ')"
printf 'PROMPT_ERR=%s\n' "$(head -c 200 "$OQA_PROJ/prompt.err" 2>/dev/null | tr '\n' ' ')"

DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if grep -q '"session.execution.succeeded"' "$DUMP" 2>/dev/null; then break; fi
  sleep 2
done

python3 - "$DUMP" <<'PY'
import json, sys
seen, scoped = set(), set()
try:
    for line in open(sys.argv[1], errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            p = (json.loads(line).get('payload') or {})
        except Exception:
            continue
        t = p.get('type')
        if t:
            seen.add(t)
            if p.get('sessionID'):
                scoped.add(t)
except FileNotFoundError:
    pass
print('EVENTS_TOTAL=%d' % len(seen))
print('SESSION_SCOPED=%s' % ','.join(sorted(scoped)))
for name in ('session.created', 'session.execution.started', 'session.execution.succeeded',
             'session.instructions.updated', 'session.step.started', 'session.step.ended'):
    print('EVENT %s=%s' % (name, 'PRESENT' if name in seen else 'ABSENT'))
print('SESSION_IDLE_EMITTED=%s' % ('yes' if 'session.idle' in seen else 'no'))
PY

cp "$OQA_PROJ/serve.err" "$OUTDIR/serve.err" 2>/dev/null || true
MSG_JSON="$(curl -sS -u "opencode:$PASS" "$OQA_SERVER_URL/api/session/$SES/message?directory=$ENC_DIR" 2>/dev/null)"
printf 'MESSAGE_COUNT=%s\n' "$(printf '%s' "$MSG_JSON" | jq -r 'if type=="array" then length else (.data|length?) // 0 end' 2>/dev/null)"
printf 'DUMP=%s\n' "$DUMP"

kill "$OQA_SERVER_PID" 2>/dev/null || true
OQA_SERVER_PID=""

AFTER_COUNT="$BEFORE_COUNT"
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi
[ "$AFTER_COUNT" = "$BEFORE_COUNT" ] && printf 'ISO=ISO_OK\n' || printf 'ISO=ISO_LEAK\n'
