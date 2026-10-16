#!/usr/bin/env bash
# Live QA, probe #5 of docs/reference/v2-port-summary.md section 8:
# a turn that overflows the context limit - do compaction events fire, does the
# turn resume, and does our `compaction` hook bridge get exercised?
#
# The mock provider reports a prompt-token count far above the model's declared
# context limit, so the host has to deal with an overflow without any real
# tokens being spent. Two runs share one session id, because a standalone server
# persists sessions in the isolated XDG database.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/compaction-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
MOCK_PY="$SCRIPT_DIR/mock-provider.py"
MODEL="mock/mock-1"
SESSION_ID="ses_probe_compaction_$(date +%s)"
# Declared context limit for the mock model; the provider reports 25x this.
CONTEXT_LIMIT=4000
REPORTED_PROMPT_TOKENS=100000

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
# The host validates the compaction summary against a fixed template and fails
# the turn when it does not match, so hand the summarisation request a
# conforming answer (section headings copied from the host's own prompt).
cat >"$OQA_PROJ/summary.md" <<'MD'
## Objective
- Exercise the host's automatic compaction path for the 2.0.30 recheck.

## Requirements
- (none)

## Decisions
- (none)

## Work State
### Completed
- The context overflow triggered a summary compaction.
### Active
- (none)
### Blocked
- (none)

## Next Move
1. (none)

## Relevant Files
- (none)

## Important Context
- (none)
MD
python3 "$MOCK_PY" --port "$PORT" --log "$BODIES" --reply "MOCK_REPLY" \
  --summary-file "$OQA_PROJ/summary.md" \
  --prompt-tokens "$REPORTED_PROMPT_TOKENS" --completion-tokens 10 \
  >"$OQA_PROJ/mock.out" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if grep -q MOCK_READY "$OQA_PROJ/mock.out" 2>/dev/null; then break; fi
  sleep 0.1
done
printf 'MOCK_PORT=%s\n' "$PORT"

python3 - "$OPENCODE_CONFIG_DIR/opencode.json" "$PORT" "$CONTEXT_LIMIT" <<'PY'
import json, sys
dst, port, context = sys.argv[1], sys.argv[2], int(sys.argv[3])
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
                    # Ask for summary compaction explicitly, so the mock model is the
                    # one the host uses to summarise rather than an inherited default.
                    "settings": {"compaction": {"type": "summary"}},
                    "limit": {"context": context, "output": 1000},
                }
            },
        }
    },
}
json.dump(cfg, open(dst, "w"), indent=2)
PY
printf '{"name":"compaction-2030"}\n' >"$OQA_PROJ/package.json"

export CATALOG_OUT="$OQA_PROJ/events.jsonl"
: >"$CATALOG_OUT"
export COMPACTION_PROBE_OUT="$OQA_PROJ/compaction-hook.jsonl"
: >"$COMPACTION_PROBE_OUT"
cat >"$OQA_PROJ/.opencode/plugins/compaction-hook-probe.ts" <<'TS'
import { appendFileSync } from "node:fs"

// Mirrors exactly what the port's compaction bridge does
// (packages/omo-opencode/src/v2/compaction-hook-mapping.ts): register on
// `ctx.session.hook("compaction")`, then append extra system text parts. The
// sentinel lets the probe assert the text reached the summary request body.
const OUT = process.env.COMPACTION_PROBE_OUT ?? "/tmp/compaction-hook-probe.jsonl"
const w = (payload: unknown) => {
  try {
    appendFileSync(OUT, JSON.stringify(payload) + "\n")
  } catch {}
}

export default {
  id: "zz-compaction-hook-probe",
  async setup(ctx: any) {
    try {
      await ctx.session.hook("compaction", async (event: any) => {
        w({
          called: true,
          sessionID: event?.sessionID ?? null,
          systemIsArray: Array.isArray(event?.system),
          messagesIsArray: Array.isArray(event?.messages),
          optionsIsRecord: !!event?.options && typeof event.options === "object",
          hasResult: event?.result !== undefined && event?.result !== null,
        })
        if (Array.isArray(event?.system) && (event?.result === undefined || event?.result === null)) {
          event.system = [...event.system, { type: "text", text: "OMO_COMPACTION_SENTINEL" }]
        }
      })
    } catch (e) {
      w({ called: false, error: String(e) })
    }
  },
}
TS
cat >"$OQA_PROJ/.opencode/plugins/event-probe.ts" <<'TS'
import { appendFileSync } from "node:fs"

// Records only envelope type + sessionID, never payload text.
const OUT = process.env.CATALOG_OUT ?? "/tmp/compaction-events.jsonl"
const w = (payload: unknown) => {
  try {
    appendFileSync(OUT, JSON.stringify(payload) + "\n")
  } catch {}
}

export default {
  id: "zz-events-compaction",
  async setup(ctx: any) {
    try {
      const iter = ctx.event.subscribe({})
      void (async () => {
        for await (const ev of iter) {
          w({
            type: ev?.type,
            sessionID: ev?.data?.sessionID ?? null,
            dataKeys: ev?.data ? Object.keys(ev.data) : null,
          })
        }
      })()
    } catch (e) {
      w({ type: "PROBE_ERR", message: String(e) })
    }
  },
}
TS

LOG_FILE="${TMPDIR:-/tmp}/oh-my-opencode.log"
LOG_BEFORE=0
if [ -f "$LOG_FILE" ]; then LOG_BEFORE="$(wc -l <"$LOG_FILE" | tr -d '[:space:]')"; fi

run_turn() {
  local label="$1" prompt="$2" out="$OQA_PROJ/run-$1.jsonl" err="$OQA_PROJ/run-$1.err" rc
  (cd "$OQA_PROJ" && timeout 180 opencode run --standalone --format json --model "$MODEL" \
    --session "$SESSION_ID" "$prompt" >"$out" 2>"$err")
  rc=$?
  printf 'TURN_%s_RC=%s\n' "$label" "$rc"
  python3 - "$out" "$label" <<'PY'
import json, sys
path, label = sys.argv[1], sys.argv[2]
texts, types = [], set()
for line in open(path, errors="replace"):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    types.add(ev.get("type"))
    part = ev.get("part") if isinstance(ev.get("part"), dict) else {}
    for src in (ev, part, ev.get("data") if isinstance(ev.get("data"), dict) else {}):
        if isinstance(src, dict) and isinstance(src.get("text"), str) and src["text"].strip():
            texts.append(src["text"].strip()[:60])
print("TURN_%s_EVENT_TYPES=%s" % (label, json.dumps(sorted(t for t in types if t))))
print("TURN_%s_FINAL_TEXT=%s" % (label, texts[-1] if texts else "MISSING"))
PY
}

run_turn ONE "Reply with the single word ONE."
run_turn TWO "Reply with the single word TWO."

kill "$MOCK_PID" 2>/dev/null
wait "$MOCK_PID" 2>/dev/null

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
printf 'SESSION_ID=%s\n' "$SESSION_ID"

python3 - "$CATALOG_OUT" "$SESSION_ID" <<'PY'
import json, sys
from collections import Counter
counts, seen_types = Counter(), set()
for line in open(sys.argv[1], errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    t = rec.get("type") or "UNKNOWN"
    counts[t] += 1
    seen_types.add(t)
print("EVENTS_TOTAL=%d" % sum(counts.values()))
compaction = sorted(t for t in seen_types if t and "compact" in t)
print("COMPACTION_EVENT_TYPES=%s" % json.dumps(compaction))
for name in ("session.compaction.started", "session.compaction.ended",
             "session.compaction.failed", "session.compacted"):
    print("HAS_%s=%s" % (name.replace(".", "_"), "yes" if name in seen_types else "no"))
print("ALL_EVENT_TYPES=%s" % json.dumps(sorted(t for t in seen_types if t)))
PY

python3 - "$BODIES" <<'PY'
import json, sys
bodies = []
for line in open(sys.argv[1], errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        body = json.loads(json.loads(line).get("raw") or "{}")
    except Exception:
        continue
    if isinstance(body, dict) and "messages" in body:
        bodies.append(body)
print("PROVIDER_REQUESTS=%d" % len(bodies))
sentinel = 0
for i, body in enumerate(bodies):
    msgs = body.get("messages") or []
    blob = json.dumps(msgs).lower()
    summary = "summar" in blob or "checkpoint" in blob
    has_sentinel = "omo_compaction_sentinel" in blob
    if has_sentinel:
        sentinel += 1
    print("REQ_%d messages=%d has_tools=%s looks_like_summary=%s has_bridge_sentinel=%s"
          % (i, len(msgs), "tools" in body, "yes" if summary else "no",
             "yes" if has_sentinel else "no"))
print("SENTINEL_REQUESTS=%d" % sentinel)
PY

python3 - "$COMPACTION_PROBE_OUT" <<'PY'
import json, sys
calls, errs = [], []
for line in open(sys.argv[1], errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if rec.get("called"):
        calls.append(rec)
    else:
        errs.append(rec)
print("COMPACTION_HOOK_CALLS=%d" % len(calls))
if calls:
    print("COMPACTION_HOOK_FIRST=%s" % json.dumps(calls[0]))
print("COMPACTION_HOOK_ERRORS=%s" % json.dumps(errs[:1]))
PY

LOG_AFTER=0
if [ -f "$LOG_FILE" ]; then LOG_AFTER="$(wc -l <"$LOG_FILE" | tr -d '[:space:]')"; fi
if [ "$LOG_AFTER" -gt "$LOG_BEFORE" ]; then
  tail -n "+$((LOG_BEFORE + 1))" "$LOG_FILE" >"$OQA_PROJ/log-window.txt" 2>/dev/null || : >"$OQA_PROJ/log-window.txt"
fi
printf 'LOG_V2_COMPACTION=%s\n' "$(grep -ac "compaction" "$OQA_PROJ/log-window.txt" 2>/dev/null || printf '0')"
printf 'LOG_V2_LINES=%s\n' "$(grep -ac "\[v2\]" "$OQA_PROJ/log-window.txt" 2>/dev/null || printf '0')"

AFTER_COUNT="$BEFORE_COUNT"
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  AFTER_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '0')"
fi
if [ "$AFTER_COUNT" = "$BEFORE_COUNT" ]; then printf 'ISO=ISO_OK\n'; else printf 'ISO=ISO_LEAK\n'; fi
printf 'SANDBOX=%s\n' "$OQA_PROJ"
