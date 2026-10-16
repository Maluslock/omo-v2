#!/usr/bin/env bash
# Live QA, probe #3 of docs/reference/v2-port-summary.md section 8:
# which generation fields does the 2.0.30 host forward to the provider request,
# and under which names?
#
# The plugin side of our port writes V2 names into `event.options` from a
# `ctx.session.hook("context")` callback (see
# packages/omo-opencode/src/v2/model-request-hook-mapping.ts). This probe puts a
# standalone plugin on that same hook, sets a distinctive value per name, and
# reads the body the host actually sends to a mock OpenAI-compatible provider.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/gen-options-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
MOCK_PY="$SCRIPT_DIR/mock-provider.py"
REAL_CONFIG="$HOME/.config/opencode/opencode.json"
PROMPT='Reply with the single word MOCK_OK and nothing else.'
MODEL="mock/mock-1"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
trap - EXIT

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR

if ! oqa_require opencode python3 >/dev/null 2>&1; then
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

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
BODIES="$OQA_PROJ/mock-bodies.jsonl"
: >"$BODIES"
python3 "$MOCK_PY" --port "$PORT" --log "$BODIES" --reply "MOCK_OK" >"$OQA_PROJ/mock.out" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if grep -q MOCK_READY "$OQA_PROJ/mock.out" 2>/dev/null; then break; fi
  sleep 0.1
done
printf 'MOCK_PORT=%s\n' "$PORT"

# Minimal config: one provider, one model, no plugins array. Credentials are the
# mock's, so no real key is involved.
python3 - "$OPENCODE_CONFIG_DIR/opencode.json" "$PORT" <<'PY'
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
printf '{"name":"gen-options-2030"}\n' >"$OQA_PROJ/package.json"

cat >"$OQA_PROJ/.opencode/plugins/gen-options-probe.ts" <<'TS'
// Sets one distinctive value per name the port's bridge can write, plus a
// sentinel that is not a generation field. Whatever shows up in the provider
// request body is what the host forwards.
export default {
  id: "gen-options-probe",
  setup(ctx) {
    ctx.session.hook("context", async (event) => {
      event.options = {
        ...(event.options || {}),
        temperature: 0.37,
        maxTokens: 1234,
        topP: 0.21,
        topK: 7,
        reasoningEffort: "low",
        omoProbeSentinel: "sentinel-value",
      }
    })
  },
}
TS

RUN_OUT="$OQA_PROJ/run.jsonl"
RUN_ERR="$OQA_PROJ/run.err"
(cd "$OQA_PROJ" && timeout 180 opencode run --standalone --format json --model "$MODEL" "$PROMPT" >"$RUN_OUT" 2>"$RUN_ERR")
RUN_RC=$?

kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
printf 'RUN_RC=%s\n' "$RUN_RC"
printf 'BODY_COUNT=%s\n' "$(wc -l <"$BODIES" | tr -d '[:space:]')"

python3 - "$BODIES" <<'PY'
import json, sys
NAMES = ["temperature", "topP", "topK", "maxTokens", "maxOutputTokens",
         "reasoningEffort", "omoProbeSentinel"]
bodies = []
for line in open(sys.argv[1], errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    try:
        body = json.loads(rec.get("raw") or "{}")
    except Exception:
        continue
    if isinstance(body, dict) and "messages" in body:
        bodies.append(body)
print("PROVIDER_REQUESTS=%d" % len(bodies))
if not bodies:
    print("FORWARDED=MISSING")
else:
    seen = {name: [] for name in NAMES}
    for body in bodies:
        for name in NAMES:
            if name in body:
                seen[name].append(body[name])
    for name in NAMES:
        vals = seen[name]
        print("FIELD_%s=%s" % (name, json.dumps(vals[0]) if vals else "ABSENT"))
    extra = sorted(set(bodies[-1]) - {"messages", "model", "stream", "temperature",
                                      "topP", "topK", "maxTokens", "maxOutputTokens",
                                      "reasoningEffort", "omoProbeSentinel"})
    print("OTHER_BODY_KEYS=%s" % json.dumps(extra))
    print("MODEL_SEEN=%s STREAM_SEEN=%s" % (bodies[-1].get("model"), bodies[-1].get("stream")))
PY

python3 - "$RUN_OUT" <<'PY'
import json, sys
final = "MISSING"
for line in open(sys.argv[1], errors="replace"):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    # --format json nests the assistant text under `part`.
    sources = [ev]
    for key in ("part", "data"):
        if isinstance(ev.get(key), dict):
            sources.append(ev[key])
    for src in sources:
        for key in ("text", "content"):
            v = src.get(key)
            if isinstance(v, str) and v.strip():
                final = v.strip()[:120]
print("FINAL_TEXT=%s" % final)
PY

printf 'RUN_ERR_TAIL=%s\n' "$(tail -3 "$RUN_ERR" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"

AFTER_COUNT="$BEFORE_COUNT"
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi
if [ "$AFTER_COUNT" = "$BEFORE_COUNT" ]; then printf 'ISO=ISO_OK\n'; else printf 'ISO=ISO_LEAK\n'; fi
printf 'SANDBOX=%s\n' "$OQA_PROJ"
