#!/usr/bin/env bash
# Read-only check of the store the port's headless session enumeration reads.
#
# Why: `packages/omo-opencode/src/tools/session-manager/sqlite-storage.ts:118` enumerates sessions with
#
#   select id, project_id, directory, title, parent_id, version, time_created, time_updated
#   from session_v2
#   where (parent_id is null or parent_id = '')
#   order by time_updated desc
#
# because V2 exposes no session listing to plugins. This re-check is the first one against a store that
# 2.0.30 created and migrated, and the per-probe sandboxes only ever see a fresh 2.0.30 database, so run
# that exact query shape against the real, migrated database - with SQLite in read-only mode and without
# an isolated XDG tree, since the real store is the subject here.
#
# Usage: bash .omo/evidence/20261016-opencode-2030-recheck/real-db-readonly-2030.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

. "$REPO_ROOT/.agents/skills/opencode-qa/scripts/lib/common.sh"

unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_CONFIG_DIR
oqa_require opencode sqlite3 >/dev/null 2>&1 || { printf 'ERROR=missing_dependency\n'; exit 1; }

DB="$(oqa_db_path)"
printf 'REAL_DB=%s\n' "${DB:-none}"
if [ -z "$DB" ] || [ ! -f "$DB" ]; then
  printf 'ERROR=real_db_not_found\n'
  exit 1
fi

ro() { sqlite3 "file:$DB?mode=ro" "$1" 2>/dev/null; }

printf 'HOST_VERSION=%s\n' "$(opencode --version 2>/dev/null)"
printf 'SESSION_TABLE_ROWS=%s\n' "$(ro 'select count(*) from session;')"
printf 'SESSION_V2_ROWS=%s\n' "$(ro 'select count(*) from session_v2;')"
printf 'BACKFILL_QUERY_REQUIRES_SQLITE_V2=%s\n' "$(ro "select count(*) from sqlite_master where type='table' and name='session_v2';")"
# The plugin's own query shape, unrolled into the numbers that matter.
printf 'BACKFILL_MAIN_ROWS=%s\n' "$(ro "select count(*) from session_v2 where (parent_id is null or parent_id = '');")"
printf 'BACKFILL_CHILD_ROWS=%s\n' "$(ro "select count(*) from session_v2 where parent_id is not null and parent_id <> '';")"
printf 'BACKFILL_DROPPED_ROWS=%s\n' "$(ro "select count(*) from session_v2 where (parent_id is null or parent_id = '') and (id is null or directory is null or time_created is null or time_updated is null);")"
printf 'BACKFILL_SAMPLE=%s\n' "$(ro "select id || ' :: ' || coalesce(title, '') from session_v2 where (parent_id is null or parent_id = '') order by time_updated desc limit 3;" | tr '\n' ';')"
printf 'MIGRATIONS_APPLIED=%s\n' "$(ro 'select count(*) from migration;')"
printf 'MIGRATIONS_NEWEST=%s\n' "$(ro 'select group_concat(id) from (select id from migration order by time_completed desc limit 3);')"
printf 'ISO=ISO_READONLY\n'
