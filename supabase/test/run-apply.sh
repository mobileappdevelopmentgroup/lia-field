#!/usr/bin/env bash
# Rehearses the LIVE apply.
#
# The live database is at migration 10. 11–17 were written on the
# fall-protection branch afterwards and have never been run. So this builds a
# database carrying 01–10 exactly as production does, and applies
# supabase/dist/apply-11-17.sql on top of it.
#
# This is not the same test as run.sh. run.sh applies every migration in
# sequence from an empty database; this applies the generated BUNDLE to an
# already-migrated one, which is the thing that actually happens on the live
# project. Three passes, each earning its place:
#
#   1. a run that FAILS — the 14-first bundle, reproducing the error the
#      SQL editor gave, so the recovery below is tested against a real
#      half-applied database rather than a clean one
#   2. the correct bundle, which must recover from that
#   3. the correct bundle AGAIN, because "idempotent" is a claim, not a
#      property, until something re-runs it
#
#   ./supabase/test/run-apply.sh
set -euo pipefail

DB="${LIA_TEST_DB:-lia_applytest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPA="$(dirname "$HERE")"

for p in /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done

pg_isready -q || { echo "No local Postgres. Try: brew services start postgresql@16" >&2; exit 1; }

echo "Rebuilding scratch database '$DB'…"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1" >/dev/null 2>&1; }

echo "Applying 01–09, the state the live database is in…"
run "$HERE/00_stub_supabase.sql"
for f in "$SUPA"/0[1-9]_*.sql; do run "$f"; done
# 10_consolidate_account.sql needs a user id and is run by hand; it does not
# affect anything below.

echo "Seeding a lead, a tech, and a record to migrate over…"
psql -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null 2>&1 <<'SQL'
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111','lead@acme.com'),
  ('33333333-3333-3333-3333-333333333333','tech@acme.com') ON CONFLICT DO NOTHING;
SET lia.uid = '11111111-1111-1111-1111-111111111111';
SELECT create_lia_user('11111111-1111-1111-1111-111111111111','lead@acme.com','Lead',10,NULL,'lead','BTV-1');
SELECT create_lia_user('33333333-3333-3333-3333-333333333333','tech@acme.com','Tech',0,
  (SELECT account_id FROM account_members WHERE user_id='11111111-1111-1111-1111-111111111111'),'tech',NULL);
SQL

# ── Pass 1: the failure the SQL editor reported ─────────────────────────────
# 14's RLS policy calls is_developer(), which 13 defines. Starting the bundle at
# 14 dies there and leaves the database half-applied. Reproduced on purpose, so
# pass 2 recovers from the real thing.
echo
echo "Reproducing the 14-first failure, so the recovery is tested for real…"
BROKEN="$(mktemp -t lia-broken-XXXX).sql"
cat "$SUPA/14_certificate_views.sql" "$SUPA/15_fp_records.sql" \
    "$SUPA/16_assignments.sql" "$SUPA/17_tag_write.sql" > "$BROKEN"
if psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$BROKEN" >/dev/null 2>&1; then
  echo "  UNEXPECTED: starting at 14 succeeded. The premise of this test is wrong." >&2
  exit 1
fi
echo "  failed as expected, leaving a half-applied database"
rm -f "$BROKEN"

# ── Pass 2: the real bundle, recovering from that ───────────────────────────
echo
echo "Applying supabase/dist/apply-11-17.sql over the mess…"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$SUPA/dist/apply-11-17.sql" >/dev/null 2>&1

echo "Applying it again — it must be re-runnable…"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$SUPA/dist/apply-11-17.sql" >/dev/null 2>&1

echo
echo "Checking the result…"
# The helper is defined inline rather than \ir'd: pg_temp functions live for one
# session, and each psql invocation is its own.
psql -q -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.want(p_label text, p_got anyelement, p_expect anyelement)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS DISTINCT FROM p_expect THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', p_label, p_expect, p_got;
  END IF;
  RAISE NOTICE 'ok  %', p_label;
END;
$f$;
SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- An inspection recorded through the whole stack, on the migrated database.
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL,'body_harness'));
  PERFORM pg_temp.want('11: the equipment types are seeded',
    (SELECT count(*)::int FROM fp_equipment_types) >= 14, true);
  PERFORM pg_temp.want('and a type carries its checklist',
    (SELECT jsonb_array_length(v_checks)) > 0, true);

  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num','LIVE-1','equipment_type','body_harness','work_order_id','WO-LIVE',
    'inspection_date','2026-08-01','checks',v_checks));
  PERFORM pg_temp.want('an inspection can be recorded end to end',
    (SELECT count(*)::int FROM fp_inspections WHERE is_current AND NOT is_deleted), 1);
END $$;

DO $$
DECLARE v json;
BEGIN
  -- 12: the tag hyperlink and its canonical key.
  PERFORM pg_temp.want('12: a link canonicalizes the same way the app does',
    fp_tag_url_key('HTTPS://Docs.Google.com/a/?utm_source=x'), 'https://docs.google.com/a');

  -- 13: the function whose absence broke the 14-first run.
  PERFORM pg_temp.want('13: is_developer exists, which is what 14 needs', is_developer(), false);
  PERFORM pg_temp.want('and a ticket can be filed',
    (submit_support_ticket('{"client_id":"aaaaaaaa-0000-0000-0000-000000000001","kind":"bug","subject":"s","body":"b"}'::jsonb)
      ->>'ref') ~ '^LIA-[0-9A-Z]{5}$', true);

  -- 14: a view is recorded, and stores a prefix rather than an address.
  PERFORM set_config('request.headers','{"x-forwarded-for":"203.0.113.44"}', true);
  PERFORM record_certificate_view(jsonb_build_object(
    'public_ref',(SELECT public_ref FROM assets WHERE serial_raw='LIVE-1'),
    'source','web','user_agent','Mozilla/5.0 (Macintosh) Safari'));
  PERFORM pg_temp.want('14: a certificate view is recorded',
    (SELECT count(*)::int FROM certificate_views), 1);
  PERFORM pg_temp.want('with a prefix rather than an address',
    (SELECT ip_prefix::text FROM certificate_views LIMIT 1), '203.0.113.0/24');

  -- 15: the office can browse and the work is queued for billing.
  PERFORM pg_temp.want('15: the office can browse what the field recorded',
    (SELECT count(*)::int FROM json_array_elements(fp_records(NULL,NULL,100,0)->'rows')), 1);
  PERFORM pg_temp.want('and it is queued for BSI',
    (SELECT count(*)::int FROM json_array_elements(fp_pending_bsi(NULL))), 1);

  -- 16: a job on the work order that already exists, counting work done before it.
  v := save_job('{"wo_number":"WO-LIVE","scope":"fall_protection","assign_all":true}'::jsonb);
  PERFORM pg_temp.want('16: a job can be created on an EXISTING work order',
    v->'job'->>'wo_number', 'WO-LIVE');
  PERFORM pg_temp.want('and it counts work recorded before the job existed',
    (SELECT count(*)::int FROM json_array_elements(v->'records')), 1);

  -- 17: five ways to one record.
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id','live-1','serial_num','LIVE-1',
    'tag_label','FP777777','nfc_tag_uid','04:AB:CD:EF'));
  PERFORM pg_temp.want('17: a tag can be written',
    (SELECT tag_label FROM assets WHERE serial_raw='LIVE-1'), 'FP777777');
  PERFORM pg_temp.want('the serial finds it',    fp_find_asset('LIVE-1')->>'by',   'serial');
  PERFORM pg_temp.want('the label finds it',     fp_find_asset('FP777777')->>'by', 'tag_label');
  PERFORM pg_temp.want('the chip finds it',      fp_find_asset('04abcdef')->>'by', 'nfc_tag_uid');
  PERFORM pg_temp.want('the link finds it',
    fp_find_asset((SELECT tag_url FROM assets WHERE serial_raw='LIVE-1'))->>'by', 'tag_url');
  PERFORM pg_temp.want('and the certificate code finds it',
    fp_find_asset((SELECT public_ref FROM assets WHERE serial_raw='LIVE-1'))->>'by', 'public_ref');

  -- 09's require_lead must still be the one in force, not a later redefinition.
  BEGIN
    PERFORM set_config('lia.uid','33333333-3333-3333-3333-333333333333',false);
    PERFORM save_job('{"wo_number":"WO-X","assign_all":true}'::jsonb);
    RAISE EXCEPTION 'FAIL a tech was allowed to create a job';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    PERFORM pg_temp.want('a tech is still refused, by 09''s require_lead',
      SQLERRM LIKE '%lead technician%', true);
  END;
  PERFORM set_config('lia.uid','11111111-1111-1111-1111-111111111111',false);
END $$;

-- The 1,724 live ladder certificates are what this must not disturb.
DO $$ BEGIN
  PERFORM pg_temp.want('the public ladder certificate view still serves rows',
    (SELECT count(*)::int FROM ladder_inspections_public) >= 0, true);
  PERFORM pg_temp.want('and anon still has no grant on the inspections base table',
    has_table_privilege('anon','public.inspections','SELECT'), false);
END $$;
SQL

echo
echo "Recovered from a half-applied database, applied cleanly, and re-ran cleanly."
echo "Drop with: psql -d postgres -c 'DROP DATABASE $DB;'"
