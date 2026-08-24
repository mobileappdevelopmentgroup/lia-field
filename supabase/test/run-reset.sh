#!/usr/bin/env bash
# Proves the destructive reset actually resets, and that a clean install on the
# other side is a working system. Separate from run.sh because it builds and
# destroys its own database rather than asserting against the shared one.
#
#   ./supabase/test/run-reset.sh
set -euo pipefail
DB="${LIA_RESET_DB:-lia_reset_test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$(dirname "$HERE")")"
for p in /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done
pg_isready -q || { echo "No local Postgres. brew services start postgresql@16" >&2; exit 1; }

fails=0
ok() { if [ "$2" = "$3" ]; then echo "ok  $1"; else echo "FAIL $1: want $3 got $2"; fails=$((fails+1)); fi; }
q()  { psql -t -A -d "$DB" -c "$1"; }

psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
psql -q -d "$DB" -f "$HERE/00_stub_supabase.sql" >/dev/null

# Populate everything, so the reset has something real to remove.
for f in 01_licensing.sql 02_inspections.sql dist/apply-all.sql 10_consolidate_account.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/$f" >/dev/null
done
psql -q -d "$DB" >/dev/null <<'SEED'
INSERT INTO auth.users(id,email) VALUES ('11111111-1111-1111-1111-111111111111','a@b.com');
SELECT create_lia_user('11111111-1111-1111-1111-111111111111','a@b.com','A',5);
SET lia.uid='11111111-1111-1111-1111-111111111111';
SELECT record_inspection('{"serial_num":"L-1","brand":"Werner"}'::jsonb);
SELECT record_fp_inspection('{"serial_num":"H-1","manufacturer":"MSA","model":"V-FIT","checks":[{"prompt":"ok?","result":true}]}'::jsonb);
SEED

ok "a populated database has Lia tables" "$([ "$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" -gt 10 ] && echo yes)" "yes"

psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/dist/reset-and-install.sql" >/dev/null 2>&1
ok "the reset removes every Lia table"    "$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" "0"
ok "and every Lia function"               "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")" "0"
# The one thing that must survive: logins.
ok "but auth.users is untouched"          "$(q "SELECT count(*) FROM auth.users")" "1"

for f in 01_licensing.sql 02_inspections.sql dist/apply-all.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/$f" >/dev/null
done
psql -q -d "$DB" >/dev/null <<'SEED2'
SELECT create_lia_user('11111111-1111-1111-1111-111111111111','a@b.com','Alex',10,NULL,'lead','BTV-0001');
SET lia.uid='11111111-1111-1111-1111-111111111111';
SELECT record_inspection('{"serial_num":"L-1","brand":"Werner"}'::jsonb);
SELECT record_fp_inspection('{"serial_num":"H-1","manufacturer":"MSA","model":"V-FIT","checks":[{"prompt":"ok?","result":true}]}'::jsonb);
SEED2

# A clean install starts with one account, so ownerless rows cannot arise.
ok "a clean install has exactly one account" "$(q "SELECT count(*) FROM accounts")" "1"
ok "with no ownerless inspections"           "$(q "SELECT count(*) FROM inspections WHERE account_id IS NULL")" "0"
ok "both scopes record"                      "$(q "SELECT count(DISTINCT kind) FROM assets")" "2"
ok "and the device snapshot serves them"     "$(q "SET lia.uid='11111111-1111-1111-1111-111111111111'; SELECT count(*) FROM account_snapshot()" | tail -1)" "2"

# The leak this reset closes: anon could read the base table on the live DB.
ok "anon cannot read the inspections table"  "$(q "SELECT has_table_privilege('anon','public.inspections','SELECT')")" "f"
ok "but can read the public certificate view" "$(q "SELECT has_table_privilege('anon','public.ladder_inspections_public','SELECT')")" "t"
ok "and cannot read fall protection either"  "$(q "SELECT has_table_privilege('anon','public.fp_inspections','SELECT')")" "f"

psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB;"
echo
[ "$fails" -eq 0 ] && echo "RESULT: all passed" || { echo "RESULT: $fails failure(s)"; exit 1; }
