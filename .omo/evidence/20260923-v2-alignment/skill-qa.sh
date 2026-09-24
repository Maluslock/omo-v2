#!/usr/bin/env bash
# Live QA for the omo V2 skill port (ctx.skill.transform).
#
# Drives a private, XDG-isolated opencode server with the omo dist loaded from this repo and dumps
# the host's full skill list from inside a command execution, where the domain is fully populated.
#
# Usage: bash .omo/evidence/20260923-v2-alignment/skill-qa.sh [port]
set -uo pipefail

PORT="${1:-14370}"
ROOT=/home/user/omo-v2
RUN="$ROOT/.omo/tmp/skill-qa-$$"
mkdir -p "$ROOT/.omo/tmp"
PROJ="$RUN/proj"
XDG="$RUN/xdg"
PW=probepw
export PATH="/home/user/.nvm/versions/node/v22.16.0/bin:$PATH"

mkdir -p "$XDG"/{data,config,state,cache} "$PROJ/.opencode/plugins" "$PROJ/.omo" \
  "$PROJ/.opencode/skills/git-master"
ln -s "$ROOT/node_modules" "$PROJ/node_modules"
echo '{"$schema":"https://opencode.ai/config.json"}' > "$PROJ/opencode.json"

# A project skill deliberately named like one of omo's builtins: the native copy must win.
printf -- '---\nname: git-master\ndescription: PROJECT OVERRIDE\n---\n\nPROJECT GIT MASTER BODY\n' \
  > "$PROJ/.opencode/skills/git-master/SKILL.md"

# omo config: disable one builtin so the gate is observable.
cat > "$PROJ/.omo/omo.jsonc" <<'EOF'
{
  "[opencode]": {
    "disabled_skills": ["frontend"],
    "browser_automation_engine": { "provider": "playwright" }
  }
}
EOF

cat > "$PROJ/.opencode/plugins/omo-local.ts" <<EOF
export { default } from "$ROOT/dist/index.js"
EOF
cat > "$PROJ/.opencode/plugins/zz-skill-dump.ts" <<'EOF'
import { appendFileSync } from "node:fs"
export default { id: "zz-skill-dump", async setup(ctx: any) {
  await ctx.command.transform((e: any) => {
    e.add({ name: "probe-skills", description: "dump the skill list", execute: async () => {
      const raw: any = await ctx.skill.list({})
      const arr = Array.isArray(raw) ? raw : (raw?.data ?? [])
      appendFileSync("__DUMP_PATH__", JSON.stringify(
        arr.map((s: any) => ({ id: s?.id, path: s?.path, contentLen: (s?.content ?? "").length }))
      ) + "\n")
    }})
  })
} }
EOF
sed -i "s|__DUMP_PATH__|$RUN/skill-dump.json|" "$PROJ/.opencode/plugins/zz-skill-dump.ts"

OMO_LOG=/tmp/oh-my-opencode.log
OMO_BEFORE=$(wc -l < "$OMO_LOG")
rm -f "$RUN/skill-dump.json"

cd "$PROJ"
nohup env XDG_DATA_HOME="$XDG/data" XDG_CONFIG_HOME="$XDG/config" XDG_STATE_HOME="$XDG/state" \
  XDG_CACHE_HOME="$XDG/cache" OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_SERVER_PASSWORD="$PW" \
  opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs > "$RUN/serve.log" 2>&1 &
SERVER_PID=$!
echo "project=$PROJ"
echo "server_pid=$SERVER_PID"

AUTH="-u opencode:$PW"
BASE="http://127.0.0.1:$PORT"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' $AUTH "$BASE/api/info" || true)
  [ "$code" = "200" ] && { echo "server_ready_after=${i}s"; break; }
  sleep 1
done

SID=$(curl -s $AUTH -X POST "$BASE/api/session" -H 'content-type: application/json' \
  -d "{\"location\":{\"directory\":\"$PROJ\"},\"agent\":\"build\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
curl -s -o /dev/null $AUTH -X POST "$BASE/api/session/$SID/command" \
  -H 'content-type: application/json' -d '{"name":"probe-skills","text":""}'
sleep 2

echo "--- omo registration line for this instance ---"
tail -n +$((OMO_BEFORE + 1)) "$OMO_LOG" | grep -a "skills registered" | head -2

export SKILL_DUMP="$RUN/skill-dump.json"
OUTPUT=$(python3 - <<'PY'
import json, os

raw = open(os.environ["SKILL_DUMP"]).read().strip().splitlines()
skills = json.loads(raw[-1]) if raw else []
by_id = {s["id"]: s for s in skills}
print(json.dumps({"count": len(skills), "ids": sorted(by_id)}, indent=2))
print("----")

virtual = [s for s in skills if s["path"].startswith("/omo-builtin/")]
on_disk = [s for s in skills if not s["path"].startswith("/")]
missing = [s["path"] for s in on_disk if not os.path.exists(s["path"])]

checks = [
    ("host builtin 'opencode' still present", "opencode" in by_id),
    ("a project skill with a builtin's name keeps the project path",
     by_id.get("git-master", {}).get("path", "").endswith("/.opencode/skills/git-master/SKILL.md")),
    ("omo registers compiled builtins under virtual /omo-builtin paths", len(virtual) >= 5),
    ("omo registers shared-bundle skills from the materialized bundle",
     any("/dist/skills/" in s["path"] or "/shared-skills/skills/" in s["path"] for s in skills)),
    ("shared-bundle-only skills are present",
     any(name in by_id for name in ("refactor", "ulw-plan", "programming", "ast-grep"))),
    ("every path omo registered for a disk skill exists on disk", not missing),
    ("disabled_skills removed 'frontend'", "frontend" not in by_id),
    ("omo builtin content is not empty", all(s["contentLen"] > 0 for s in virtual)),
]
for label, ok in checks:
    print(("PASS " if ok else "FAIL ") + label)
if missing:
    print("missing paths: " + json.dumps(missing))
PY
)
echo "$OUTPUT"
PASS=$(grep -c '^PASS' <<<"$OUTPUT" || true)
FAIL=$(grep -c '^FAIL' <<<"$OUTPUT" || true)
echo "--- summary: pass=$PASS fail=$FAIL ---"
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
[ "$FAIL" = "0" ]
