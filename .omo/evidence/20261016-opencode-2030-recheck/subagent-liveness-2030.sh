#!/usr/bin/env bash
# Live QA, probe #4 of docs/reference/v2-port-summary.md section 8 - the probe
# that used to be listed as "covered by probe 2".
#
# Question: on 2.0.30, does the plugin bus still report a *second* session (the
# shape a delegated subagent or team member has) as busy while it works?
#
# Why it matters: the port's liveness fix (5b3e790) rebuilds V1's `session.status`
# map from the turn envelope, because an empty map tells the background manager
# that every session is gone and it stops a live subagent after ~9s
# (packages/omo-opencode/src/v2/session-activity.ts). That derivation has unit
# tests; what a host upgrade can break is the input - whether
# `session.execution.started|succeeded` still arrives on the plugin bus keyed by
# the child session's own id.
#
# How: serve a plugin that records (type, sessionID) for every envelope, create a
# parent session and a child session with `parentID` set, prompt ONLY the child,
# and make the mock provider answer 12s late - longer than the ~9s gone-window
# and longer than `MIN_SESSION_GONE_POLLS` covers. The capture is then replayed
# through the real activity tracker, which prints the status map the shim would
# have returned mid-turn and after the turn.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/subagent-liveness-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROBE_SRC="$SCRIPT_DIR/event-catalog-probe-2030.ts"
REPLAY_SRC="$SCRIPT_DIR/session-activity-replay.ts"
MOCK_PY="$SCRIPT_DIR/mock-provider.py"
OUTDIR="$REPO_ROOT/.omo/tmp/event-catalog-2030"
DUMP="$OUTDIR/liveness-dump.jsonl"
DELAY_SECONDS="${DELAY_SECONDS:-12}"
MIDTURN_AFTER="${MIDTURN_AFTER:-10}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="bun"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
# Do NOT clear the library's EXIT trap: oqa_cleanup kills leftover servers and
# removes the sandbox.

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 curl jq python3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

REALDB="$(oqa_db_path)"
BEFORE_COUNT=""
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '')"
fi

mkdir -p "$OUTDIR"
rm -f "$DUMP"

oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

MOCK_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
MOCK_LOG="$OQA_PROJ/mock-bodies.jsonl"
: >"$MOCK_LOG"
python3 "$MOCK_PY" --port "$MOCK_PORT" --log "$MOCK_LOG" --reply "CHILD_OK" --delay-seconds "$DELAY_SECONDS" \
  >"$OQA_PROJ/mock.out" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if grep -q MOCK_READY "$OQA_PROJ/mock.out" 2>/dev/null; then break; fi
  sleep 0.1
done
printf 'MOCK_PORT=%s\nDELAY_SECONDS=%s\nMIDTURN_AFTER=%s\n' "$MOCK_PORT" "$DELAY_SECONDS" "$MIDTURN_AFTER"

# Minimal mock config: this probe needs no real credentials, so no real config is
# copied and no real tokens are spent. The mock is the only provider.
python3 - "$OPENCODE_CONFIG_DIR/opencode.json" "$MOCK_PORT" <<'PY'
import json, sys
dst, port = sys.argv[1], sys.argv[2]
cfg = {
    "model": "mock/mock-1",
    "providers": {
        "mock": {
            "package": "aisdk:@ai-sdk/openai-compatible",
            "settings": {"apiKey": "mock-key", "baseURL": "http://127.0.0.1:%s/v1" % port},
            "models": {
                "mock-1": {
                    "name": "Mock One",
                    "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                    "limit": {"context": 200000, "output": 4096},
                }
            },
        }
    },
}
json.dump(cfg, open(dst, "w"), indent=2)
PY
cp "$PROBE_SRC" "$OQA_PROJ/.opencode/plugins/zz-events-2030.ts"
printf '{"name":"subagent-liveness-2030"}\n' >"$OQA_PROJ/package.json"

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
# 2.0.30 moved the HTTP API under /api; the routes are the server's own
# /openapi.json, not guessed.
PARENT_RAW="$(curl -sS -u "opencode:$PASS" -X POST "$OQA_SERVER_URL/api/session?directory=$ENC_DIR" \
  -H 'content-type: application/json' -d '{"title":"liveness parent"}' 2>/dev/null)"
PARENT="$(printf '%s' "$PARENT_RAW" | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null)"
if [ -z "$PARENT" ]; then printf 'ERROR=parent_create_failed\n'; printf 'PARENT_RAW=%s\n' "${PARENT_RAW:0:300}"; exit 1; fi

CHILD_RAW="$(curl -sS -u "opencode:$PASS" -X POST "$OQA_SERVER_URL/api/session?directory=$ENC_DIR" \
  -H 'content-type: application/json' -d "{\"title\":\"liveness child\",\"parentID\":\"$PARENT\"}" 2>/dev/null)"
CHILD="$(printf '%s' "$CHILD_RAW" | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null)"
if [ -z "$CHILD" ]; then printf 'ERROR=child_create_failed\n'; printf 'CHILD_RAW=%s\n' "${CHILD_RAW:0:300}"; exit 1; fi
printf 'PARENT_SESSION=%s\nCHILD_SESSION=%s\n' "$PARENT" "$CHILD"
printf 'CHILD_PARENT_FIELD=%s\n' "$(printf '%s' "$CHILD_RAW" | jq -r '(.parentID // .data.parentID) // "ABSENT"' 2>/dev/null)"

# Prompt only the child. The parent never runs a turn, so a child-tagged event
# cannot be a mislabelled parent event, and an empty parent is part of the claim.
PROMPT_CODE="$(curl -sS -u "opencode:$PASS" -o "$OQA_PROJ/prompt.out" -w '%{http_code}' \
  -X POST "$OQA_SERVER_URL/api/session/$CHILD/prompt?directory=$ENC_DIR" \
  -H 'content-type: application/json' -d '{"text":"Reply with exactly CHILD_OK"}' 2>"$OQA_PROJ/prompt.err")"
printf 'PROMPT_HTTP=%s\n' "$PROMPT_CODE"
printf 'PROMPT_BODY=%s\n' "$(head -c 200 "$OQA_PROJ/prompt.out" 2>/dev/null | tr '\n' ' ')"

# Snapshot while the mock is still holding the reply: this is the "keeps working"
# window the background manager polls.
sleep "$MIDTURN_AFTER"
MIDTURN="$OUTDIR/liveness-midturn.jsonl"
cp "$DUMP" "$MIDTURN" 2>/dev/null || : >"$MIDTURN"

child_done() {
  python3 - "$DUMP" "$CHILD" <<'PY'
import json, sys
try:
    lines = open(sys.argv[1], errors='replace').read().splitlines()
except FileNotFoundError:
    sys.exit(1)
for line in lines:
    try:
        p = (json.loads(line).get('payload') or {})
    except Exception:
        continue
    if p.get('type') == 'session.execution.succeeded' and p.get('sessionID') == sys.argv[2]:
        sys.exit(0)
sys.exit(1)
PY
}

DEADLINE=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if child_done; then break; fi
  sleep 2
done
printf 'CHILD_SUCCEEDED_WITHIN_DEADLINE=%s\n' "$(child_done && printf yes || printf no)"
printf 'PROVIDER_REQUESTS=%s\n' "$(wc -l <"$MOCK_LOG" 2>/dev/null | tr -d '[:space:]')"

python3 - "$DUMP" "$MIDTURN" "$CHILD" "$PARENT" <<'PY'
import json, sys

def events(path):
    out = []
    try:
        lines = open(path, errors='replace').read().splitlines()
    except FileNotFoundError:
        return out
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            p = (json.loads(line).get('payload') or {})
        except Exception:
            continue
        if isinstance(p.get('type'), str) and isinstance(p.get('sessionID'), str):
            out.append((p['type'], p['sessionID']))
    return out

full, mid, child, parent = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
full_events, mid_events = events(full), events(mid)

def scoped(evs, sid):
    return sorted({t for t, s in evs if s == sid})

child_types, parent_types = scoped(full_events, child), scoped(full_events, parent)
mid_child_types = scoped(mid_events, child)
print('CHILD_EVENT_TYPES=%s' % (','.join(child_types) or 'none'))
print('CHILD_HAS_EXECUTION_STARTED=%s' % ('yes' if 'session.execution.started' in child_types else 'no'))
print('CHILD_HAS_EXECUTION_SUCCEEDED=%s' % ('yes' if 'session.execution.succeeded' in child_types else 'no'))
print('PARENT_EVENT_TYPES=%s' % (','.join(parent_types) or 'none'))
print('OTHER_SESSION_IDS=%s' % (','.join(sorted({s for _, s in full_events} - {child, parent})) or 'none'))
# Mid-turn: the child has started and has NOT finished yet, so a tracker fed this
# window must still report it busy.
mid_busy = 'session.execution.started' in mid_child_types and 'session.execution.succeeded' not in mid_child_types
print('MIDTURN_EVENTS=%d' % len(mid_events))
print('MIDTURN_CHILD_TYPES=%s' % (','.join(mid_child_types) or 'none'))
print('MIDTURN_CHILD_STILL_WORKING=%s' % ('yes' if mid_busy else 'no'))
PY

# Replay the capture through the real tracker shipped in the port.
printf 'REPLAY_MIDTURN_BEGIN\n'
(cd "$REPO_ROOT" && "$BUN" "$REPLAY_SRC" "$MIDTURN" 2>&1)
printf 'REPLAY_FULL_BEGIN\n'
(cd "$REPO_ROOT" && "$BUN" "$REPLAY_SRC" "$DUMP" 2>&1)

kill "$OQA_SERVER_PID" 2>/dev/null || true
OQA_SERVER_PID=""
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true

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
printf 'DUMP=%s\nMIDTURN_DUMP=%s\nSANDBOX=%s\n' "$DUMP" "$MIDTURN" "$OQA_PROJ"
