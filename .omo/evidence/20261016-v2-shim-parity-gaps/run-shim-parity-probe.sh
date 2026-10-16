#!/usr/bin/env bash
# Live QA for the three V2 client-shim parity fixes (see README.md).
#
# Loads ONLY the probe plugin into a real opencode 2.0.30 server. The probe
# imports the PRODUCTION `client-shim.ts` / `tool-mapping.ts` sources and calls
# them against the live plugin context, which is the one link unit tests cannot
# cover: the shim's mapping vs. the host's actual session/tool domains.
#
# The omo `dist/` build is deliberately NOT loaded here - the probe exercises
# source, and a stale build would only make the capture ambiguous. Real-plugin
# regression is covered separately by run-recheck-all.sh after `bun run build`.
#
# Usage: bash .omo/evidence/20261016-v2-shim-parity-gaps/run-shim-parity-probe.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROBE_SRC="$SCRIPT_DIR/zz-shim-parity-probe.ts"
MOCK_PY="$SCRIPT_DIR/mock-provider.py"
OUTDIR="$REPO_ROOT/.omo/tmp/shim-parity-probe"
PROBE_OUT="$OUTDIR/probe.jsonl"
MOCK_LOG="$OUTDIR/mock-bodies.jsonl"
TARGET_FILE="$OUTDIR/summarize-target.txt"
SERVE_ERR="$OUTDIR/serve.err"
SUMMARY_FIXTURE="$SCRIPT_DIR/summary-fixture.md"

# `omo_glob` is registered as `${NAMESPACE}_${name}`, so the probe tool
# (`toV2Tool("zz_shim_probe", ..., { namespace: "zzprobe" })`) is this id.
TOOL_ID="${TOOL_ID:-zzprobe_zz_shim_probe}"
MARKER="${MARKER:-PROBE_MARKER}"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
# Do NOT clear the library's EXIT trap: oqa_cleanup kills leftover servers and
# removes the sandbox.

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 curl jq python3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

# 2.0.30 removed `opencode db path` (which is why oqa_db_path is blind here), so
# resolve the real DB through `debug paths` BEFORE the sandbox repoints $HOME.
REALDB="$(opencode debug paths 2>/dev/null | awk '$1 == "db" { print $2 }')"
[ -n "$REALDB" ] || REALDB="$HOME/.local/share/opencode/opencode.db"
BEFORE_COUNT=""
if [ -f "$REALDB" ]; then
  BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '')"
fi

mkdir -p "$OUTDIR"
rm -f "$PROBE_OUT" "$MOCK_LOG" "$TARGET_FILE" "$SERVE_ERR"

oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

MOCK_PORT="$(oqa_free_port)"
: >"$MOCK_LOG"
python3 "$MOCK_PY" --port "$MOCK_PORT" --log "$MOCK_LOG" --reply "TURN_DONE" \
  --tool-call "$TOOL_ID" --tool-args '{"mode":"all"}' --tool-call-marker "$MARKER" \
  --summary-file "$SUMMARY_FIXTURE" \
  --prompt-tokens 24000 --completion-tokens 8 \
  >"$OQA_PROJ/mock.out" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if grep -q MOCK_READY "$OQA_PROJ/mock.out" 2>/dev/null; then break; fi
  sleep 0.1
done
printf 'MOCK_PORT=%s\nTOOL_ID=%s\nMARKER=%s\n' "$MOCK_PORT" "$TOOL_ID" "$MARKER"

# Minimal mock config: the probe needs no real credentials and must not spend
# real tokens. The mock is the only provider, and it only offers the probe tool
# on the request whose prompt carries $MARKER.
python3 - "$OPENCODE_CONFIG_DIR/opencode.json" "$MOCK_PORT" "$TOOL_ID" <<'PY'
import json, sys
dst, port, tool_id = sys.argv[1], sys.argv[2], sys.argv[3]
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
cp "$PROBE_SRC" "$OQA_PROJ/.opencode/plugins/zz-shim-parity-probe.ts"
printf '{"name":"shim-parity-probe"}\n' >"$OQA_PROJ/package.json"

PORT="$(oqa_free_port)"
PASS="oqa-${RANDOM}${RANDOM}"
export SHIM_PROBE_REPO="$REPO_ROOT"
export SHIM_PROBE_OUT="$PROBE_OUT"
export SHIM_PROBE_TARGET_FILE="$TARGET_FILE"
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

create_session() {
  local title="$1" body
  body="$(printf '{"title":"%s"}' "$title")"
  curl -sS -u "opencode:$PASS" -X POST "$OQA_SERVER_URL/api/session?directory=$ENC_DIR" \
    -H 'content-type: application/json' -d "$body" 2>/dev/null
}

prompt_session() {
  local ses="$1" text="$2"
  curl -sS -u "opencode:$PASS" -o "$OQA_PROJ/prompt.out" -w '%{http_code}' \
    -X POST "$OQA_SERVER_URL/api/session/$ses/prompt?directory=$ENC_DIR" \
    -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$text")" 2>/dev/null
}

# No registration gate before the first prompt: opencode loads a project plugin
# LAZILY, on the first turn of a session. `registered` cannot appear earlier, and
# a pre-prompt wait would only burn 60s and print a false failure (the same
# laziness is why the 2026-10-16 recheck saw no `session.created` for sessions
# created before the first prompt). Registration is asserted after the driver
# turn instead, where its absence is a real failure.
printf 'PLUGIN_LOAD=lazy_first_turn\n'

# Donor session: one plain turn so the session has real messages that
# `session.summarize` can compact. Its prompt carries no $MARKER, so the mock
# answers it with text rather than a tool call.
DONOR_RAW="$(create_session "shim probe donor")"
DONOR="$(printf '%s' "$DONOR_RAW" | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null)"
if [ -z "$DONOR" ]; then printf 'ERROR=donor_create_failed\n'; printf 'DONOR_RAW=%s\n' "${DONOR_RAW:0:300}"; exit 1; fi
printf 'DONOR_SESSION=%s\n' "$DONOR"
printf 'DONOR_PROMPT_HTTP=%s\n' "$(prompt_session "$DONOR" "Reply with exactly DONOR_DONE")"

DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  grep -q "\"label\":\"event\",\"type\":\"session.execution.succeeded\",\"sessionID\":\"$DONOR\"" "$PROBE_OUT" 2>/dev/null && break
  sleep 2
done
printf 'DONOR_TURN_DONE=%s\n' "$(grep -c "\"type\":\"session.execution.succeeded\",\"sessionID\":\"$DONOR\"" "$PROBE_OUT" 2>/dev/null || printf 0)"

# The runner hands the probe its summarize target through a file, so the target
# is not baked into the mock's argv at start time.
printf '%s' "$DONOR" >"$TARGET_FILE"

# Driver session: its prompt carries $MARKER, so the mock answers with a
# tool call and the host executes the probe against a live context.
DRIVER_RAW="$(create_session "shim probe driver")"
DRIVER="$(printf '%s' "$DRIVER_RAW" | jq -r '.id // .sessionID // .data.id // empty' 2>/dev/null)"
if [ -z "$DRIVER" ]; then printf 'ERROR=driver_create_failed\n'; printf 'DRIVER_RAW=%s\n' "${DRIVER_RAW:0:300}"; exit 1; fi
printf 'DRIVER_SESSION=%s\n' "$DRIVER"
printf 'DRIVER_PROMPT_HTTP=%s\n' "$(prompt_session "$DRIVER" "$MARKER run the probe tool now")"

DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  grep -q '"label":"abort.wait"' "$PROBE_OUT" 2>/dev/null && break
  sleep 2
done
if grep -q '"label":"tool.start"' "$PROBE_OUT" 2>/dev/null; then
  printf 'PROBE_TOOL_CALLED=yes\n'
else
  printf 'PROBE_TOOL_CALLED=no\n'
fi

# The create/summarize/compaction/abort verdicts are all printed by one report
# AFTER the interrupt below: printing them here would report ABORT_OBSERVED=no,
# because the probe is still parked on `await context.abort` at this point.

# Second witness for the parentID fix: ask the host for the child session rather
# than trusting the value the shim echoed back.
CHILD="$(grep -o '"label":"create.result"[^}]*' "$PROBE_OUT" 2>/dev/null | head -1 | python3 -c 'import sys,re;m=re.search(r"\"id\":\"([^\"]+)\"",sys.stdin.read());print(m.group(1) if m else "")')"
if [ -n "$CHILD" ]; then
  CHILD_RAW="$(curl -sS -u "opencode:$PASS" "$OQA_SERVER_URL/api/session/$CHILD?directory=$ENC_DIR" 2>/dev/null)"
  printf 'HOST_CHILD_PARENTID=%s\n' "$(printf '%s' "$CHILD_RAW" | jq -r '(.parentID // .data.parentID) // "ABSENT"' 2>/dev/null)"
  printf 'CHILD_PARENT_MATCH=%s\n' "$([ "$(printf '%s' "$CHILD_RAW" | jq -r '(.parentID // .data.parentID) // ""' 2>/dev/null)" = "$DRIVER" ] && printf yes || printf no)"
else
  printf 'HOST_CHILD_PARENTID=NO_CHILD\nCHILD_PARENT_MATCH=no\n'
fi

# Interrupt route discovered from the server's own spec (b47's lesson: never
# hard-code a 2.0.x route).
INT_ROUTE="$(curl -sS -u "opencode:$PASS" "$OQA_SERVER_URL/openapi.json" 2>/dev/null \
  | jq -r '[.paths | keys[] | select(test("interrupt"))] | first // empty' 2>/dev/null)"
printf 'INTERRUPT_ROUTE=%s\n' "${INT_ROUTE:-NONE}"
if [ -n "$INT_ROUTE" ]; then
  INT_URL="${INT_ROUTE//\{sessionID\}/$DRIVER}"
  printf 'INTERRUPT_HTTP=%s\n' "$(curl -sS -u "opencode:$PASS" -o /dev/null -w '%{http_code}' \
    -X POST "$OQA_SERVER_URL$INT_URL?directory=$ENC_DIR" 2>/dev/null)"
fi

DEADLINE=$(( $(date +%s) + 75 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  grep -q '"label":"abort.observed"' "$PROBE_OUT" 2>/dev/null && break
  sleep 2
done
printf 'ABORT_RECORDED=%s\n' "$(grep -c '"label":"abort.observed"' "$PROBE_OUT" 2>/dev/null || printf 0)"

# Let the interrupted step's trailing events reach the probe before reporting.
sleep 3

# Single consolidated report, taken once every stage has settled.
python3 - "$PROBE_OUT" "$DONOR" <<'PY'
import json, sys
path, donor = sys.argv[1], sys.argv[2]
rows = []
try:
    for line in open(path, errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
except FileNotFoundError:
    pass


def first(label):
    for row in rows:
        if row.get('label') == label:
            return row
    return {}


def count(label):
    return sum(1 for row in rows if row.get('label') == label)


setup = first('setup')
registered = first('registered')
print('PROBE_REGISTERED=%d' % count('registered'))
print('PROBE_SETUP=%s' % ('yes' if setup else 'no'))
if registered:
    print('PROBE_TOOL_ID=%s_%s' % (registered.get('namespace'), registered.get('name')))
if setup:
    print('HOST_HAS_SESSION_COMPACT=%s' % setup.get('hasSessionCompact'))
create = first('create.result')
print('CREATE_ID=%s' % (create.get('id') or 'NONE'))
print('CREATE_RETURNED_PARENTID=%s' % (create.get('returnedParentID') or 'NONE'))
print('CREATE_REQUESTED_PARENTID=%s' % (create.get('requestedParentID') or 'NONE'))
print('CREATE_ERROR=%s' % (create.get('error') or create.get('threw') or 'NONE'))
summarize = first('summarize.result')
if not summarize:
    print('SUMMARIZE_RESOLVED=NONE')
    print('SUMMARIZE_ERROR=NONE')
else:
    print('SUMMARIZE_RESOLVED=%s' % ('yes' if summarize.get('resolved') else 'no'))
    print('SUMMARIZE_ERROR=%s' % (summarize.get('error') or 'NONE'))
compactions = [
    row for row in rows
    if row.get('label') == 'event'
    and str(row.get('type', '')).startswith('session.compaction')
    and row.get('sessionID') == donor
]
print('COMPACTION_EVENTS_FOR_TARGET=%d' % len(compactions))
print('COMPACTION_EVENT_TYPES=%s' % (','.join(sorted({str(r.get('type')) for r in compactions})) or 'NONE'))
abort = first('abort.observed')
print('ABORT_OBSERVED=%s' % ('yes' if abort else 'no'))
print('ABORT_OUTCOME=%s' % (abort.get('outcome') or 'NONE'))
print('ABORT_ABORTED=%s' % (abort.get('aborted') if abort else 'NONE'))
v1 = [row for row in rows if row.get('label') == 'v1event' and row.get('type') == 'message.updated']
finished = [row for row in v1 if row.get('finish')]
v1_created = [row for row in rows if row.get('label') == 'v1event' and row.get('type') == 'session.created']
raw_created = [row for row in rows if row.get('label') == 'event' and row.get('type') == 'session.created']


def created_ids(entries, key):
    out = set()
    for row in entries:
        value = row.get(key)
        if isinstance(value, str) and value:
            out.add(value)
    return out


v1_created_ids = created_ids(v1_created, 'id')
raw_created_ids = created_ids(raw_created, 'sessionID')
print('V1_MESSAGE_UPDATED=%d' % len(v1))
print('V1_MESSAGE_UPDATED_FINISHED=%d' % len(finished))
print('V1_MESSAGE_UPDATED_ROLE=%s' % (','.join(sorted({str(r.get('role')) for r in v1})) or 'NONE'))
print('V1_MESSAGE_UPDATED_PROVIDER=%s' % (','.join(sorted({str(r.get('providerID')) for r in finished if r.get('providerID')})) or 'NONE'))
print('V1_MESSAGE_UPDATED_MODEL=%s' % (','.join(sorted({str(r.get('modelID')) for r in finished if r.get('modelID')})) or 'NONE'))
print('V1_MESSAGE_UPDATED_TOKENS=%s' % ('yes' if any(r.get('hasTokens') for r in finished) else 'no'))
print('V1_MESSAGE_UPDATED_TIME=%s' % ('yes' if any(r.get('timeCreated') and r.get('timeCompleted') for r in finished) else 'no'))
print('V1_SESSION_CREATED=%s' % (','.join(sorted(v1_created_ids)) or 'NONE'))
print('RAW_SESSION_CREATED=%s' % (','.join(sorted(raw_created_ids)) or 'NONE'))
print('V1_CREATED_WITHOUT_RAW=%s' % (','.join(sorted(v1_created_ids - raw_created_ids)) or 'NONE'))
parts = [row for row in rows if row.get('label') == 'v1part']
part_updated = [row for row in parts if row.get('type') == 'message.part.updated']
part_delta = [row for row in parts if row.get('type') == 'message.part.delta']
print('V1_PART_UPDATED=%d' % len(part_updated))
print('V1_PART_DELTA=%d' % len(part_delta))
print('V1_PART_KINDS=%s' % (','.join(sorted({r.get('partType') for r in part_updated if r.get('partType')})) or 'NONE'))
print('V1_PART_FIELDS=%s' % (','.join(sorted({r.get('field') for r in part_delta if r.get('field')})) or 'NONE'))
print('V1_SESSION_STOP=%d' % len([row for row in parts if row.get('type') == 'session.stop']))
print('RAW_STREAM_TYPES=%s' % (','.join(sorted({row.get('type') for row in rows if row.get('label') == 'event'})) or 'NONE'))
if not setup:
    print('ERROR=probe_setup_missing')
elif not registered:
    print('ERROR=probe_not_registered')
PY

printf 'PROBE_OUT=%s\nMOCK_LOG=%s\n' "$PROBE_OUT" "$MOCK_LOG"
printf 'MOCK_TOOL_CALLS=%s\n' "$(grep -c '"decision": "tool_call"' "$MOCK_LOG" 2>/dev/null || printf 0)"
printf 'MOCK_TEXT_REPLIES=%s\n' "$(grep -c '"decision": "text"' "$MOCK_LOG" 2>/dev/null || printf 0)"

cp "$OQA_PROJ/serve.err" "$SERVE_ERR" 2>/dev/null || true

kill "$OQA_SERVER_PID" 2>/dev/null || true
OQA_SERVER_PID=""
kill "$MOCK_PID" 2>/dev/null || true

AFTER_COUNT="$BEFORE_COUNT"
if [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '')"
fi
printf 'ISO_DB=%s\nISO_BEFORE=%s\nISO_AFTER=%s\n' "${REALDB:-NONE}" "${BEFORE_COUNT:-NONE}" "${AFTER_COUNT:-NONE}"
[ -n "$BEFORE_COUNT" ] && [ "$AFTER_COUNT" = "$BEFORE_COUNT" ] && printf 'ISO=ISO_OK\n' || printf 'ISO=ISO_LEAK\n'
