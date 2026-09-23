#!/usr/bin/env bash
# Live QA for the omo V2 slash-command port.
#
# Drives a private, XDG-isolated opencode server with the omo dist loaded from this repo, then
# invokes each built-in command through the real session command API - one fresh session per
# command, so a failed model turn cannot mask the next command's delivery - and reads back the
# user message the command delivered.
#
# Usage: bash .omo/evidence/20260923-v2-alignment/command-qa.sh [port]
set -uo pipefail

PORT="${1:-14322}"
ROOT=/home/user/omo-v2
RUN=/tmp/ocmd-qa-$$
PROJ="$RUN/proj"
XDG="$RUN/xdg"
PW=probepw
NAME=opencode
export PATH="/home/user/.nvm/versions/node/v22.16.0/bin:$PATH"

# The project gates two commands off; that is also the negative control for `disabled_commands`.
DISABLED_JSON='["hyperplan", "handoff"]'

mkdir -p "$XDG"/{data,config,state,cache} "$PROJ/.opencode/plugins" "$PROJ/.omo"
ln -s "$ROOT/node_modules" "$PROJ/node_modules"
echo '{"$schema":"https://opencode.ai/config.json"}' > "$PROJ/opencode.json"
cat > "$PROJ/.opencode/plugins/omo-local.ts" <<EOF
export { default } from "$ROOT/dist/index.js"
EOF
cat > "$PROJ/.omo/omo.jsonc" <<EOF
{
  "[opencode]": {
    "disabled_commands": $DISABLED_JSON,
    "browser_automation_engine": { "provider": "playwright" }
  }
}
EOF

OMO_LOG=/tmp/oh-my-opencode.log
OMO_BEFORE=$(wc -l < "$OMO_LOG")

cd "$PROJ"
nohup env XDG_DATA_HOME="$XDG/data" XDG_CONFIG_HOME="$XDG/config" XDG_STATE_HOME="$XDG/state" \
  XDG_CACHE_HOME="$XDG/cache" OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_SERVER_PASSWORD="$PW" \
  opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs > "$RUN/serve.log" 2>&1 &
SERVER_PID=$!
echo "project=$PROJ"
echo "server_pid=$SERVER_PID"

AUTH="-u $NAME:$PW"
BASE="http://127.0.0.1:$PORT"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' $AUTH "$BASE/api/info" || true)
  [ "$code" = "200" ] && { echo "server_ready_after=${i}s"; break; }
  sleep 1
done

PASS=0
FAIL=0
check() {
  if [ "$1" = "1" ]; then PASS=$((PASS + 1)); echo "PASS $2"; else FAIL=$((FAIL + 1)); echo "FAIL $2"; fi
}

new_session() {
  curl -s $AUTH -X POST "$BASE/api/session" -H 'content-type: application/json' \
    -d "{\"location\":{\"directory\":\"$PROJ\"},\"agent\":\"build\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])"
}

session_agent() {
  curl -s $AUTH "$BASE/api/session/$1" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('agent'))"
}

# Prints {"count": n, "text": "..."} for the delivered user message(s) of one session.
read_delivered() {
  curl -s $AUTH "$BASE/api/session/$1/message" | python3 -c "
import sys, json
rows = json.load(sys.stdin).get('data', [])
texts = []
for m in rows:
    t = m.get('text') if isinstance(m, dict) else None
    if not isinstance(t, str):
        t = (m.get('payload') or {}).get('text') if isinstance(m, dict) else None
    if isinstance(t, str) and t.strip():
        texts.append(t)
print(json.dumps({'count': len(texts), 'text': (texts[-1] if texts else '')}))
"
}

# invoke <name> <json-text> <ok|disabled> <marker>
invoke() {
  local name="$1" text="$2" expect="$3" marker="$4"
  local sid code delivered
  sid=$(new_session)
  code=$(curl -s -o /dev/null -w '%{http_code}' $AUTH -X POST "$BASE/api/session/$sid/command" \
    -H 'content-type: application/json' -d "{\"name\":\"$name\",\"text\":$text}")
  sleep 1
  delivered=$(read_delivered "$sid")
  echo "--- $name sid=$sid http=$code"
  printf '%s' "$delivered" > "$RUN/delivered.json"
  python3 - "$RUN/delivered.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
text = row["text"]
print(f"    delivered_count={row['count']} len={len(text)}")
print("    head=" + json.dumps(text[:80]))
print("    tail=" + json.dumps(text[-80:]))
PY
  if [ "$expect" = "ok" ]; then
    [ "$code" = "204" ] && check 1 "$name accepted (204)" || check 0 "$name accepted (got $code)"
    echo "$delivered" | python3 -c "
import json,sys
row=json.loads(sys.stdin.read())
t=row['text']
ok = row['count'] >= 1 and len(t) > 200
assert_placeholder = '\$SESSION_ID' not in t and '\$TIMESTAMP' not in t and '\$ARGUMENTS' not in t
print(json.dumps({'delivered':ok,'no_placeholders':assert_placeholder}))
" > "$RUN/assert.json"
    grep -q '"delivered": true' "$RUN/assert.json" && check 1 "$name delivered a non-trivial user message" || check 0 "$name delivered"
    grep -q '"no_placeholders": true' "$RUN/assert.json" && check 1 "$name expanded every placeholder" || check 0 "$name left a placeholder unexpanded"
    if [ -n "$marker" ]; then
      echo "$delivered" | grep -qF "$marker" && check 1 "$name delivered: $marker" || check 0 "$name missing: $marker"
    fi
  else
    [ "$code" = "404" ] && check 1 "$name rejected as disabled/unknown (404)" || check 0 "$name rejected (got $code)"
  fi
}

invoke goal '"QA-OBJECTIVE"' ok 'QA-OBJECTIVE'
invoke stop-continuation '""' ok ''
invoke refactor '"QA-TARGET"' ok ''
invoke remove-ai-slops '""' ok ''
invoke handoff '"QA-HANDOFF"' disabled ''
invoke hyperplan '""' disabled ''
invoke nonexistent-command '""' disabled ''

# /start-work declares agent: atlas, so a fresh session must end up on atlas and the delivered
# text must carry the expanded $SESSION_ID.
SW_SID=$(new_session)
echo "--- start-work sid=$SW_SID agent_before=$(session_agent "$SW_SID")"
SW_CODE=$(curl -s -o /dev/null -w '%{http_code}' $AUTH -X POST "$BASE/api/session/$SW_SID/command" \
  -H 'content-type: application/json' -d '{"name":"start-work","text":"QA-PLAN"}')
sleep 1
SW_DELIVERED=$(read_delivered "$SW_SID")
printf '%s' "$SW_DELIVERED" > "$RUN/sw-delivered.json"
python3 - "$RUN/sw-delivered.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
text = row["text"]
print(f"    delivered_count={row['count']} len={len(text)}")
print("    head=" + json.dumps(text[:90]))
print("    tail=" + json.dumps(text[-90:]))
PY
echo "    http=$SW_CODE agent_after=$(session_agent "$SW_SID")"
[ "$SW_CODE" = "204" ] && check 1 "start-work accepted (204)" || check 0 "start-work accepted (got $SW_CODE)"
# V2 registers omo's agents under display ids, so the command's "atlas" must arrive as the resolved id.
[ "$(session_agent "$SW_SID")" = "Atlas - Plan Executor" ] \
  && check 1 "start-work switched the session to the registered atlas id" \
  || check 0 "start-work agent (got $(session_agent "$SW_SID"))"
echo "$SW_DELIVERED" | grep -qF "$SW_SID" && check 1 "start-work expanded \$SESSION_ID" || check 0 "start-work \$SESSION_ID"
echo "$SW_DELIVERED" | grep -qF 'QA-PLAN' && check 1 "start-work delivered the user argument" || check 0 "start-work argument"

# Routes a python block's PASS/FAIL lines through check() so the summary and exit code see them.
run_python_checks() {
  while IFS= read -r line; do
    case "$line" in
      "PASS "*) check 1 "${line#PASS }" ;;
      "FAIL "*) check 0 "${line#FAIL }" ;;
      *) echo "$line" ;;
    esac
  done
}

echo "--- omo registration line for THIS instance (2 commands disabled, browser=playwright) ---"
REG_LINE=$(tail -n +$((OMO_BEFORE + 1)) "$OMO_LOG" | grep -a "commands registered" | tail -1)
echo "$REG_LINE"
REG=$(python3 -c "
import json, re, sys
line = sys.argv[1]
m = re.search(r'(\{\"registered\".*\})\s*\$', line)
print(json.dumps(json.loads(m.group(1))) if m else '{}')
" "$REG_LINE")
run_python_checks < <(python3 - "$REG" <<'PY'
import json, sys
reg = json.loads(sys.argv[1])
names = set(reg.get("names", []))
expected_absent = {"handoff", "hyperplan"}
expected_present = {
    "goal", "refactor", "start-work", "stop-continuation", "remove-ai-slops",
    "playwright", "frontend", "git-master", "review-work", "init-deep", "debugging",
    "security-research", "security-review", "visual-qa",
}
print("PASS omo registered the 5 builtin commands plus 9 builtin skill commands"
      if names == expected_present else f"FAIL command set was {sorted(names)}")
print("PASS configured-off commands are absent"
      if not (names & expected_absent) else f"FAIL disabled commands registered: {sorted(names & expected_absent)}")
PY
)

echo "--- invoking a skill-backed command (/git-master) ---"
GM_SID=$(new_session)
GM_CODE=$(curl -s -o /dev/null -w '%{http_code}' $AUTH -X POST "$BASE/api/session/$GM_SID/command" \
  -H 'content-type: application/json' -d '{"name":"git-master","text":"QA-SKILL"}')
sleep 1
read_delivered "$GM_SID" > "$RUN/gm-delivered.json"
python3 - "$RUN/gm-delivered.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
print(f"    delivered_count={row['count']} len={len(row['text'])}")
print("    head=" + json.dumps(row["text"][:80]))
PY
run_python_checks < <(python3 - "$RUN/gm-delivered.json" <<'PY'
import json, sys
text = json.load(open(sys.argv[1]))["text"]
ok = "<skill-instruction>" in text and "QA-SKILL" in text
print(("PASS " if ok else "FAIL ") + "git-master delivered the wrapped skill template with the user argument")
PY
)
[ "$GM_CODE" = "204" ] && check 1 "git-master accepted (204)" || check 0 "git-master accepted (got $GM_CODE)"

echo "--- command execution failures in this server ---"
if grep -a "command execution failed" "$RUN/serve.log" > /dev/null; then
  grep -a "command execution failed" "$RUN/serve.log" | head -5
  check 0 "no command execution failures"
else
  check 1 "no command execution failures"
fi

echo "--- summary: pass=$PASS fail=$FAIL ---"
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
[ "$FAIL" = "0" ]
