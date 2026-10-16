#!/usr/bin/env bash
# Static check for the schema claim behind probe 2: the V2 `session.*` event name
# set the port's mapping relies on is identical between the 2.0.11-era schema
# package (`@opencode/schema` 2.0.15, shipped with the plugin 2.0.11 baseline)
# and 2.0.30.
#
# Why: the live catalog (event-catalog-2030.sh) only shows what the host actually
# emitted in one turn; a name that was renamed but never emitted would hide there.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/schema-diff-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BASELINE="$REPO_ROOT/.omo/evidence/20260923-v2-alignment/research/pkgs/x_opencode_schema2.0.15/package/dist/session-event.d.ts"
WORK="$REPO_ROOT/.omo/tmp/schema-2.0.30"
NEW="$WORK/package/dist/session-event.d.ts"
VERSION="${SCHEMA_VERSION:-2.0.30}"

if [ ! -f "$BASELINE" ]; then
  printf 'ERROR=baseline_schema_missing path=%s\n' "$BASELINE"
  exit 1
fi

if [ ! -f "$NEW" ]; then
  printf 'FETCHING=@opencode/schema@%s\n' "$VERSION"
  mkdir -p "$WORK"
  (cd "$WORK" && npm pack "@opencode/schema@$VERSION" >/dev/null 2>&1 &&
    tar xzf "opencode-schema-$VERSION.tgz") || { printf 'ERROR=npm_pack_failed\n'; exit 1; }
fi

printf 'BASELINE=%s\n' "$BASELINE"
printf 'NEW=%s\n' "$NEW"
printf 'SCHEMA_VERSION=%s\n' "$VERSION"

python3 - "$BASELINE" "$NEW" <<'PY'
import re, sys

def read(p):
    return open(p, errors='replace').read()

def names(text):
    # The declarations carry their wire name as a string literal.
    return set(re.findall(r'"(session\.[A-Za-z.]+)"', text))

a_text, b_text = read(sys.argv[1]), read(sys.argv[2])
a, b = names(a_text), names(b_text)
print('BASELINE_SESSION_EVENTS=%d' % len(a))
print('NEW_SESSION_EVENTS=%d' % len(b))
print('REMOVED_IN_NEW=%s' % (','.join(sorted(a - b)) or 'none'))
print('ADDED_IN_NEW=%s' % (','.join(sorted(b - a)) or 'none'))
for name in ('session.created', 'session.idle', 'session.status', 'session.compacted',
             'session.error', 'session.execution.started', 'session.execution.succeeded',
             'session.compaction.ended'):
    print('HAS %-30s baseline=%-5s new=%s' % (name, name in a, name in b))

def line_for(text, name):
    for line in text.splitlines():
        if '"%s"' % name in line:
            return ' '.join(line.split())
    return '<absent>'

lg = line_for(b_text, 'session.created')
same = line_for(a_text, 'session.created') == lg
print('SESSION_CREATED_DECLARATION_IDENTICAL=%s' % ('yes' if same else 'no'))
print('SESSION_CREATED_DECLARATION=%s' % lg[:200])
for name in ('session.execution.started', 'session.compaction.ended'):
    print('%s_DECLARATION_IDENTICAL=%s'
          % (name.upper().replace('.', '_'),
             'yes' if line_for(a_text, name) == line_for(b_text, name) else 'no'))
PY
