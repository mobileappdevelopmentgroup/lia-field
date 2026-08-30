#!/usr/bin/env bash
# Run the SQL migrations against a throwaway local Postgres database and assert
# they behave correctly. Nothing here touches Supabase.
#
#   ./supabase/test/run.sh
#
# Needs a running local Postgres (brew install postgresql@16 && brew services
# start postgresql@16). The scratch database is dropped and recreated each run.

set -euo pipefail

DB="${LIA_TEST_DB:-lia_sqltest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPA="$(dirname "$HERE")"

for p in /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done

if ! pg_isready -q; then
  echo "No local Postgres is accepting connections." >&2
  echo "Try: brew services start postgresql@16" >&2
  exit 1
fi

echo "Rebuilding scratch database '$DB'…"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1" >/dev/null; }

echo "Applying stubs and baseline migrations…"
run "$HERE/00_stub_supabase.sql"
run "$SUPA/01_licensing.sql"
run "$SUPA/02_inspections.sql"

# 01_billing_test.sql applies 03_accounts_billing.sql itself, so that the
# backfill runs over realistic pre-migration data rather than an empty table.
# ON_ERROR_STOP + set -e means any failed assertion exits non-zero.
echo "Running billing assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/01_billing_test.sql"

# Likewise, 02 applies 04_inspections_v2.sql itself so the backfill runs over
# inspection rows that were written in the old shape.
echo
echo "Running inspection assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/02_inspections_test.sql"

echo
echo "Running attribution assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/03_attribution_test.sql"

echo
echo "Running fall protection assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/04_fall_protection_test.sql"

echo
echo "Running status assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/05_status_test.sql"

echo
echo "Running snapshot assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/06_snapshot_test.sql"

echo
echo "Running authoring assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/07_authoring_test.sql"

echo
echo "Running equipment type assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/09_equipment_types_test.sql"

echo
echo "Running tag link assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/10_tag_links_test.sql"

echo
echo "Running support assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/11_support_test.sql"

echo
echo "Running certificate view assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/12_certificate_views_test.sql"

echo
echo "Running fp record assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/13_fp_records_test.sql"

echo
echo "Running job assignment assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/14_assignments_test.sql"

echo
echo "Running tag write assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/15_tag_write_test.sql"

# Last, because it deliberately reshapes everything above.
echo
echo "Running consolidation assertions…"
echo
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/08_consolidate_test.sql"

echo
echo "Inspect with: psql -d $DB"
echo "Drop with:    psql -d postgres -c 'DROP DATABASE $DB;'"
