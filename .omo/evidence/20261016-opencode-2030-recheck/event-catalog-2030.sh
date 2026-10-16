#!/usr/bin/env bash
# Live QA: the V2 event vocabulary a plugin actually sees on opencode 2.0.30.
#
# Why: omo's V1 hooks key off `session.idle`, but V2 never emits that name; the
# adapter maps `session.execution.succeeded` -> `session.idle` and
# `session.compaction.ended` -> `session.compacted`. If 2.0.30 renamed or dropped
# those, every idle-keyed hook silently dies again. This probe re-captures the
# catalog a plugin receives and diffs it against the 2.0.11 baseline.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/event-catalog-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROBE_SRC="$SCRIPT_DIR/event-catalog-probe-2030.ts"
DUMP="$REPO_ROOT/.omo/tmp/event-catalog-2030/dump.jsonl"
MODEL="${MODEL:-deepseek/deepseek-v4-pro}"
# Absolute: oqa_mk_isolated_xdg repoints $HOME at the sandbox.
REAL_CONFIG="${REAL_CONFIG:-/home/user/.config/opencode/opencode.json}"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"
# Do NOT clear the library's EXIT trap: oqa_cleanup kills leftover servers and
# removes the sandbox.

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 python3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

REALDB="$(oqa_db_path)"
BEFORE_COUNT=""
if [ -n "$REALDB" ] && [ -f "$REALDB" ]; then
  BEFORE_COUNT="$(sqlite3 "$REALDB" 'SELECT count(*) FROM session;' 2>/dev/null || printf '')"
fi

mkdir -p "$(dirname "$DUMP")"
rm -f "$DUMP"

oqa_mk_isolated_xdg || { printf 'ERROR=isolated_xdg_failed\n'; exit 1; }
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR" "$OQA_PROJ/.opencode/plugins"

# Copy the real config (so the provider credentials the prompt needs exist) but
# drop the plugin array: the probe must be the only plugin in the run.
python3 - "$REAL_CONFIG" "$OPENCODE_CONFIG_DIR/opencode.json" <<'PY'
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
cfg = json.loads(re.sub(r'^\s*//.*$', '', open(src).read(), flags=re.M))
cfg.pop('plugins', None)
cfg.pop('plugin', None)
json.dump(cfg, open(dst, 'w'), indent=2)
PY
cp "$PROBE_SRC" "$OQA_PROJ/.opencode/plugins/zz-events-2030.ts"

RUN_OUT="$OQA_PROJ/run.jsonl"
(cd "$OQA_PROJ" && CATALOG_OUT="$DUMP" timeout 180 opencode run --standalone --format json --model "$MODEL" \
  "Reply with exactly CATALOG_DONE" >"$RUN_OUT" 2>"$OQA_PROJ/run.err")
RUN_RC=$?

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
printf 'RUN_RC=%s\n' "$RUN_RC"
printf 'DUMP_LINES=%s\n' "$(wc -l <"$DUMP" 2>/dev/null | tr -d '[:space:]')"

python3 - "$DUMP" "$REPO_ROOT/.omo/evidence/20260923-v2-alignment/live-v2-event-catalog.md" <<'PY'
import json, sys, re
dump, baseline_md = sys.argv[1], sys.argv[2]

observed, session_scoped = set(), set()
errs = []
try:
    for line in open(dump, errors='replace'):
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get('label') == 'event ERR':
            errs.append(rec.get('payload'))
            continue
        p = rec.get('payload') or {}
        t = p.get('type')
        if not t:
            continue
        observed.add(t)
        if p.get('sessionID'):
            session_scoped.add(t)
except FileNotFoundError:
    pass

# The 2.0.11 baseline, transcribed from the sibling evidence file's fenced block.
baseline = set()
try:
    text = open(baseline_md, errors='replace').read()
    for m in re.finditer(r'^  (session\.[a-z.]+)$', text, re.M):
        baseline.add(m.group(1).strip())
except FileNotFoundError:
    pass

critical = {
    'session.execution.started': 'turn start',
    'session.execution.succeeded': 'turn end -> session.idle mapping',
    'session.created': 'session lifecycle',
}
print('SESSION_SCOPED=%s' % ','.join(sorted(session_scoped)))
print('OBSERVED_TOTAL=%d' % len(observed))
for name, why in critical.items():
    print('CRITICAL %s=%s (%s)' % (name, 'PRESENT' if name in observed else 'ABSENT', why))
print('SESSION_IDLE_EMITTED=%s' % ('yes' if 'session.idle' in observed else 'no'))
print('SESSION_STATUS_EMITTED=%s' % ('yes' if 'session.status' in observed else 'no'))
if baseline:
    missing = sorted(baseline - observed)
    added = sorted(observed - baseline)
    print('BASELINE_SESSION_EVENTS=%d' % len(baseline))
    print('MISSING_VS_BASELINE=%s' % (','.join(missing) if missing else 'none'))
    print('NEW_VS_BASELINE=%s' % (','.join(added) if added else 'none'))
print('PROBE_ERRORS=%s' % (';'.join(errs) if errs else 'none'))
PY

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

printf 'DUMP=%s\n' "$DUMP"
printf 'SANDBOX=%s\n' "$OQA_PROJ"
