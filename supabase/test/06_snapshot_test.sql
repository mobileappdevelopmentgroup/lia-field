-- Device snapshot / on-device cache. Runs after 05_status_test.sql.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'
\set BETA '22222222-2222-2222-2222-222222222222'

\ir _helpers.sql
\ir ../migrations/08_device_snapshot.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- ── The snapshot carries both scopes ─────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('the snapshot returns the account''s items',
    (SELECT count(*)::int > 0 FROM account_snapshot()), true);
  PERFORM pg_temp.want('ladders and fall protection come down together',
    (SELECT count(DISTINCT kind)::int FROM account_snapshot()), 2);
END $$;

-- ── A tapped item comes back filled in, so the tech types nothing ────────────
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM account_snapshot() WHERE serial_key = 'H1001' AND kind = 'fall_protection';
  PERFORM pg_temp.want('the item is found by its normalized serial', r.serial_raw, 'H-1001');
  PERFORM pg_temp.want('manufacturer comes down',  r.manufacturer, 'MSA');
  PERFORM pg_temp.want('model comes down',         r.model, 'V-FIT');
  PERFORM pg_temp.want('item type comes down',     r.item_type, 'Harness');
  PERFORM pg_temp.want('lot number comes down',    r.lot_number, 'LOT-88');
  PERFORM pg_temp.want('manufacture year comes down', r.mfg_year, 2024);
  -- Recorded without an explicit date in 04, so it defaulted to today.
  PERFORM pg_temp.want('last inspected comes down', r.last_inspected, current_date);
  PERFORM pg_temp.want('and so does the next due date', r.next_due, current_date + 365);
  PERFORM pg_temp.want('the responsible rep comes down', r.rep_number, 'BTV-4471');
  -- This is what makes the NFC tap work offline.
  PERFORM pg_temp.want('the tag id comes down', r.nfc_tag_uid, '04A1B2C3');
END $$;

-- A ladder resolves to ladder fields, not fall-protection ones.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM account_snapshot() WHERE serial_key = 'SN001' AND kind = 'ladder';
  PERFORM pg_temp.want('a ladder carries its brand',  r.brand, 'Werner');
  PERFORM pg_temp.want('a ladder carries its length', r.length, '28');
  PERFORM pg_temp.want('and no fall-protection fields', r.manufacturer, NULL::text);
END $$;

-- ── Scoped to the ACCOUNT, so every tech gets the whole catalogue ────────────
DO $$
DECLARE v_lead int; v_sub int;
BEGIN
  SELECT count(*)::int INTO v_lead FROM account_snapshot();
  PERFORM set_config('lia.uid', '33333333-3333-3333-3333-333333333333', false);
  SELECT count(*)::int INTO v_sub FROM account_snapshot();
  -- Items cross crews, so a sub-tech must see what the lead sees.
  PERFORM pg_temp.want('a sub-tech gets the same catalogue as the lead', v_sub, v_lead);
END $$;

-- ...but never another company's.
DO $$ BEGIN
  PERFORM set_config('lia.uid', '22222222-2222-2222-2222-222222222222', false);
  PERFORM pg_temp.want('another account sees none of it',
    (SELECT count(*)::int FROM account_snapshot()), 0);
  PERFORM set_config('lia.uid', '11111111-1111-1111-1111-111111111111', false);
END $$;

-- ── Delta sync ───────────────────────────────────────────────────────────────
DO $$
DECLARE v_mark timestamptz; v_all int; v_delta int; v_id uuid;
BEGIN
  SELECT count(*)::int INTO v_all FROM account_snapshot();
  -- clock_timestamp(), not now(): now() would be this transaction's start time,
  -- which is the exact trap the trigger has to avoid.
  v_mark := clock_timestamp();
  PERFORM pg_sleep(0.05);

  PERFORM pg_temp.want('nothing has changed since the mark',
    (SELECT count(*)::int FROM account_snapshot(v_mark)), 0);

  -- Re-inspecting an item must make it reappear in the delta.
  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num','H-1001','inspection_date', current_date + 1,
    'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',true))));

  SELECT count(*)::int INTO v_delta FROM account_snapshot(v_mark);
  PERFORM pg_temp.want('a re-inspected item shows up in the delta', v_delta, 1);
  PERFORM pg_temp.want('and the delta is far smaller than the full sync', v_delta < v_all, true);
END $$;

-- ── Keyset pagination ────────────────────────────────────────────────────────
DO $$
DECLARE v_total int; v_page1 int; v_last_u timestamptz; v_last_id uuid; v_page2 int;
BEGIN
  SELECT count(*)::int INTO v_total FROM account_snapshot();

  SELECT count(*)::int INTO v_page1 FROM account_snapshot(NULL, 2);
  PERFORM pg_temp.want('a page is capped at the requested size', v_page1, 2);

  SELECT updated_at, asset_id INTO v_last_u, v_last_id
    FROM account_snapshot(NULL, 2) ORDER BY updated_at DESC, asset_id DESC LIMIT 1;

  SELECT count(*)::int INTO v_page2 FROM account_snapshot(NULL, 1000, v_last_u, v_last_id);
  -- No overlap, no gap: the pages add up to the whole set.
  PERFORM pg_temp.want('the next page continues where the first stopped', v_page1 + v_page2, v_total);
END $$;

-- ── Sizing the first sync ────────────────────────────────────────────────────
DO $$
DECLARE m json;
BEGIN
  m := account_snapshot_meta();
  PERFORM pg_temp.want('meta counts everything on a first sync',
    (m->>'total')::int, (m->>'changed')::int);
  PERFORM pg_temp.want('meta breaks the count down by scope',
    (m->>'ladders')::int + (m->>'fp')::int, (m->>'total')::int);
  -- Taken from the server so a device with a wrong clock cannot skip records.
  PERFORM pg_temp.want('meta hands back a server timestamp to sync against',
    (m->>'server_now') IS NOT NULL, true);
  -- Backdated on purpose: a row stamped before its transaction commits would
  -- otherwise fall into the gap and never be seen again.
  PERFORM pg_temp.want('the mark the client stores is backdated for safety',
    (m->>'next_since')::timestamptz < (m->>'server_now')::timestamptz, true);
END $$;

-- ── Idempotency ──────────────────────────────────────────────────────────────
\ir ../migrations/08_device_snapshot.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration leaves the snapshot working',
    (SELECT count(*)::int > 0 FROM account_snapshot()), true);
  PERFORM pg_temp.want('and does not duplicate the touch trigger',
    (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'inspections_touch_asset'), 1);
END $$;

-- ── anon must not reach it ───────────────────────────────────────────────────
-- A real anon request carries no JWT, so auth.uid() is NULL. Clear the stub to
-- match; SET ROLE alone would not, since the function is SECURITY DEFINER and
-- reads the stubbed uid regardless of the current role.
DO $$ BEGIN PERFORM set_config('lia.uid', '', false); END $$;
DO $$ BEGIN
  PERFORM pg_temp.want('with no session there is no account to serve',
    (SELECT count(*)::int FROM account_snapshot()), 0);
END $$;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon is not allowed to call the snapshot at all',
    $q$ SELECT count(*) FROM account_snapshot() $q$);
  PERFORM pg_temp.want_error('nor to size it up',
    $q$ SELECT account_snapshot_meta() $q$);
END $$;
RESET ROLE;

\echo ''
\echo 'All snapshot assertions passed.'
