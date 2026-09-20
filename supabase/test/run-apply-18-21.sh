#!/usr/bin/env bash
# Rehearses the LIVE apply of 18–21.
#
# The live database carries 01–17. This builds a database that looks like that,
# with data in it, and applies supabase/dist/apply-18-21.sql on top — which is
# the thing that actually happens in the SQL editor. run.sh is a different test:
# it applies every migration in sequence from empty.
#
# Two passes, because "idempotent" is a claim until something re-runs it.
#
#   ./supabase/test/run-apply-18-21.sh
set -euo pipefail

DB="${LIA_TEST_DB:-lia_apply1821}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPA="$(dirname "$HERE")"

for p in /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done

pg_isready -q || { echo "No local Postgres. Try: brew services start postgresql@16" >&2; exit 1; }

echo "Rebuilding '$DB' at migration 17, the way production stands…"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1" >/dev/null; }

run "$HERE/00_stub_supabase.sql"
for f in "$SUPA"/0[1-9]_*.sql "$SUPA"/1[0-7]_*.sql; do run "$f"; done

echo "Seeding a production-shaped account…"
psql -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<'SQL'
INSERT INTO auth.users(id,email) VALUES
  ('d7bdb210-ae3d-4560-8de0-49ea73d09d80','lead@example.test'),
  ('a8738ff3-412e-4369-8298-6fc37aa9a1b2','tech@example.test') ON CONFLICT DO NOTHING;
SELECT create_lia_user('d7bdb210-ae3d-4560-8de0-49ea73d09d80','lead@example.test','The Lead',-1,NULL,'lead','734');
SELECT create_lia_user('a8738ff3-412e-4369-8298-6fc37aa9a1b2','tech@example.test','The Tech',0,
  (SELECT account_id FROM account_members WHERE user_id='d7bdb210-ae3d-4560-8de0-49ea73d09d80'),'tech');
SET lia.uid = 'a8738ff3-412e-4369-8298-6fc37aa9a1b2';
SELECT record_inspection('{"serial_num":"PROD-1","work_order_id":"WO-PROD"}'::jsonb);
SQL

# What the certificate says BEFORE — the field person's name, which is the
# disclosure 19 closes.
BEFORE=$(psql -tA -d "$DB" -c "SELECT tech_name FROM ladder_inspections_public WHERE serial_num='PROD-1'")
echo "  before: the public certificate names '$BEFORE'"

for pass in 1 2; do
  echo
  echo "Applying supabase/dist/apply-18-21.sql — pass $pass…"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$SUPA/dist/apply-18-21.sql" >/dev/null
  echo "  applied cleanly"
done

echo
echo "Checking the result…"
psql -v ON_ERROR_STOP=1 -v helpers="$HERE/_helpers.sql" -q -d "$DB" <<'SQL'
\i :helpers
DO $$
DECLARE v_acct uuid;
BEGIN
  SELECT account_id INTO v_acct FROM account_members WHERE user_id='d7bdb210-ae3d-4560-8de0-49ea73d09d80';

  PERFORM pg_temp.want('the certificate now names the responsible lead',
    (SELECT tech_name FROM ladder_inspections_public WHERE serial_num='PROD-1'), 'The Lead');
  PERFORM pg_temp.want('and the organisation behind it',
    (SELECT verified_by FROM ladder_inspections_public WHERE serial_num='PROD-1'), 'The Lead');
  PERFORM pg_temp.want('the field person is still recorded for the office',
    (SELECT collector_name FROM inspections WHERE serial_num='PROD-1'), 'The Tech');
  PERFORM pg_temp.want('and is not published',
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name='ladder_inspections_public'
        AND column_name IN ('collector_name','collected_by')), 0);

  -- The property that makes this safe to apply before anything is restructured.
  PERFORM set_config('lia.uid','d7bdb210-ae3d-4560-8de0-49ea73d09d80', true);
  PERFORM pg_temp.want('an unlinked account still sees exactly its own work',
    (SELECT count(*)::int FROM account_descendants(v_acct)), 1);
  PERFORM pg_temp.want('and my_account_id is unchanged with no session',
    my_account_id(), v_acct);
  PERFORM pg_temp.want('nobody is impersonating anything', is_impersonating(), false);
  PERFORM pg_temp.want('and the lead is offered nobody to act as, having no subs',
    json_array_length(my_context()->'can_act_as'), 0);
END $$;
SQL

echo
echo "Bundle rehearsal passed."
echo "Inspect with: psql -d $DB"
echo "Drop with:    psql -d postgres -c 'DROP DATABASE $DB;'"
