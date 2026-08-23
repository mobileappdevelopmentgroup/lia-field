-- Fall protection. Runs after 03_attribution_test.sql.

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'
\set BETA '22222222-2222-2222-2222-222222222222'

\ir _helpers.sql
\ir ../06_fall_protection.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- ── A passing item ───────────────────────────────────────────────────────────
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num','H-1001', 'manufacturer','MSA', 'model','V-FIT',
    'item_type','Harness', 'lot_number','LOT-88', 'mfg_month',4, 'mfg_year',2024,
    'status','In Service', 'nfc_tag_serial','04A1B2C3', 'work_order_id','WO-FP-1',
    'checks', jsonb_build_array(
      jsonb_build_object('ord',0,'code','labels','prompt','Are all labels and markings present, secured and legible?','result',true),
      jsonb_build_object('ord',1,'code','impact','prompt','Has the impact indicator been activated?','result',true))));

  PERFORM pg_temp.want('a passing item passes overall',
    (SELECT overall_pass FROM fp_inspections WHERE id = v_id), true);
  PERFORM pg_temp.want('due date is one year out',
    (SELECT next_due_date - inspection_date FROM fp_inspections WHERE id = v_id), 365);
  PERFORM pg_temp.want('both checks were recorded',
    (SELECT count(*)::int FROM fp_inspection_checks WHERE fp_inspection_id = v_id), 2);
  PERFORM pg_temp.want('the responsible rep is carried onto the item',
    (SELECT rep_number FROM fp_inspections WHERE id = v_id), 'BTV-4471');
  PERFORM pg_temp.want('the NFC tag id is stored on the asset',
    (SELECT nfc_tag_uid FROM assets WHERE serial_key = 'H1001'), '04A1B2C3');
END $$;

-- ── The catalogue accumulates as techs type ──────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('a new manufacturer+model enters the catalogue',
    (SELECT count(*)::int FROM fp_models WHERE lower(manufacturer)='msa' AND lower(model)='v-fit'), 1);

  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num','H-1002','manufacturer','MSA','model','v-fit',
    'checks', jsonb_build_array(jsonb_build_object('prompt','Labels legible?','result',true))));

  -- Same combination typed with different casing must not create a second entry.
  PERFORM pg_temp.want('a differently-cased model is the same catalogue entry',
    (SELECT count(*)::int FROM fp_models WHERE lower(manufacturer)='msa' AND lower(model)='v-fit'), 1);
END $$;

-- ── A failing check condemns the item ────────────────────────────────────────
DO $$
DECLARE v_id uuid;
BEGIN
  -- The overall assessment is computed from the checks, never taken from the
  -- client — so claiming a pass alongside a failed check cannot work.
  v_id := record_fp_inspection(jsonb_build_object(
    'serial_num','H-2001','manufacturer','MSA','model','V-FIT',
    'overall_pass', true,
    'discard_reason','impact indicator deployed',
    'checks', jsonb_build_array(
      jsonb_build_object('prompt','Are all labels present?','result',true),
      jsonb_build_object('prompt','Has the impact indicator been activated?','result',false))));

  PERFORM pg_temp.want('one failed check fails the whole item',
    (SELECT overall_pass FROM fp_inspections WHERE id = v_id), false);
  PERFORM pg_temp.want('the discard reason is on record',
    (SELECT discard_reason FROM fp_inspections WHERE id = v_id), 'impact indicator deployed');
END $$;

-- A condemned item without a reason must be refused outright.
DO $$ BEGIN
  PERFORM pg_temp.want_error('a failed item cannot be saved without a discard reason',
    $q$ SELECT record_fp_inspection(jsonb_build_object(
          'serial_num','H-2002','manufacturer','MSA','model','V-FIT',
          'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',false)))) $q$);
END $$;

-- ── Versioning, same as ladders ──────────────────────────────────────────────
DO $$
DECLARE v_a uuid; v_b uuid; v_date date := current_date;
BEGIN
  v_a := record_fp_inspection(jsonb_build_object(
    'serial_num','H-3001','manufacturer','Petzl','model','AVAO','inspection_date',v_date,
    'description','first pass',
    'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',true))));
  v_b := record_fp_inspection(jsonb_build_object(
    'serial_num','H-3001','manufacturer','Petzl','model','AVAO','inspection_date',v_date,
    'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',true))));

  PERFORM pg_temp.want('re-recording creates version 2',
    (SELECT version FROM fp_inspections WHERE id = v_b), 2);
  PERFORM pg_temp.want('the earlier record is kept',
    (SELECT count(*)::int FROM fp_inspections i JOIN assets a ON a.id=i.asset_id
      WHERE a.serial_key='H3001'), 2);
  PERFORM pg_temp.want('only one is current',
    (SELECT count(*)::int FROM fp_inspections i JOIN assets a ON a.id=i.asset_id
      WHERE a.serial_key='H3001' AND i.is_current), 1);
  PERFORM pg_temp.want('a value the second write omitted is carried forward',
    (SELECT description FROM fp_inspections WHERE id = v_b), 'first pass');
END $$;

-- ── A ladder and a fall-protection item may share a serial ───────────────────
DO $$ BEGIN
  PERFORM record_inspection(jsonb_build_object('serial_num','H-1001','tech_name','Acme Lead'));
  PERFORM pg_temp.want('the same serial in each scope is two different assets',
    (SELECT count(*)::int FROM assets WHERE serial_key='H1001'), 2);
  PERFORM pg_temp.want('and they are distinguished by kind',
    (SELECT count(DISTINCT kind)::int FROM assets WHERE serial_key='H1001'), 2);
END $$;

-- ── Photo retention ──────────────────────────────────────────────────────────
DO $$
DECLARE v_insp uuid; v_acct uuid;
BEGIN
  SELECT id, account_id INTO v_insp, v_acct FROM fp_inspections
   WHERE discard_reason IS NOT NULL LIMIT 1;

  INSERT INTO inspection_photos (account_id, subject_id, storage_path, uploaded_by)
  VALUES (v_acct, v_insp, 'acct/wo/insp/a.jpg', '11111111-1111-1111-1111-111111111111');

  PERFORM pg_temp.want('a photo expires two years after upload',
    (SELECT (expires_at::date - uploaded_at::date) FROM inspection_photos
      WHERE storage_path='acct/wo/insp/a.jpg'), 730);
  PERFORM pg_temp.want('nothing is expired yet',
    (SELECT count(*)::int FROM expired_photos()), 0);

  -- Backdate past retention; the sweeper should now offer it up.
  UPDATE inspection_photos SET expires_at = now() - interval '1 day'
   WHERE storage_path='acct/wo/insp/a.jpg';
  PERFORM pg_temp.want('an over-age photo is offered to the sweeper',
    (SELECT count(*)::int FROM expired_photos()), 1);
END $$;

-- ── Idempotency ──────────────────────────────────────────────────────────────
\ir ../06_fall_protection.sql
DO $$ BEGIN
  PERFORM pg_temp.want('re-running the migration keeps the catalogue intact',
    (SELECT count(*)::int FROM fp_models), 2);
  -- H-1001, H-1002, H-2001 and H-3001. H-2002 was correctly refused for having
  -- a failed check with no discard reason, so it is not here.
  PERFORM pg_temp.want('re-running the migration keeps inspections intact',
    (SELECT count(*)::int FROM fp_inspections WHERE is_current), 4);
END $$;

-- ── Isolation and what the public may see ────────────────────────────────────
SET ROLE authenticated;
SET lia.uid = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
  PERFORM pg_temp.want('another account sees none of these fall-protection records',
    (SELECT count(*)::int FROM fp_inspections), 0);
  PERFORM pg_temp.want_error('a tech cannot write fp_inspections directly',
    $q$ UPDATE fp_inspections SET overall_pass = true $q$);
END $$;
RESET ROLE;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot reach the fall-protection table',
    $q$ SELECT count(*) FROM fp_inspections $q$);
  PERFORM pg_temp.want('anon can read the public certificate view',
    (SELECT count(*)::int > 0 FROM fall_protection_public), true);
  PERFORM pg_temp.want('the public certificate never exposes the discard reason',
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_name='fall_protection_public'
        AND column_name IN ('discard_reason','collected_by','collector_name','work_order_id')), 0);
  PERFORM pg_temp.want('but it does show pass/fail',
    (SELECT count(*)::int FROM fall_protection_public WHERE overall_pass = false), 1);
  PERFORM pg_temp.want('and the checks as they were actually asked',
    (SELECT count(*)::int > 0 FROM fall_protection_checks_public), true);
END $$;
RESET ROLE;

\echo ''
\echo 'All fall protection assertions passed.'
