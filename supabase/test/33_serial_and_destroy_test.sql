-- Placeholder serials refused by the database (39) and destroyed ladders on
-- the certificate (40). Runs after 32_field_edits_test.sql.
--
-- What has to hold:
--   * no write path can record an item under N/A, NONE, 0000, "-" … however
--     it is spelled — ladder, fall protection, office add, serial correction,
--     history import — and the refusal says what to do;
--   * a real serial that merely CONTAINS one of those words is accepted;
--   * a row already holding a placeholder (from before 39) is not frozen: it
--     can still be tagged or corrected, just not recorded against again;
--   * a history import reports the bad row and imports the rest;
--   * a ladder booked with a destroy part (PMCD, PMCD1–6, TRL-3) reads as
--     destroyed, with its reason, on the PUBLIC certificate view; a correction
--     that removes the part un-destroys it; quantity 0 is not booked.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/39_placeholder_serials.sql
\ir ../migrations/40_destroyed_ladders.sql
-- Twice: the paste is idempotent.
\ir ../migrations/39_placeholder_serials.sql
\ir ../migrations/40_destroyed_ladders.sql

UPDATE impersonation_sessions SET ended_at = now() WHERE ended_at IS NULL;

-- ── serial_problem(), the rule itself ───────────────────────────────────────
SELECT pg_temp.want('N/A is a placeholder',          serial_problem('N/A'), 'placeholder');
SELECT pg_temp.want('n.a. is the same word',         serial_problem(' n.a. '), 'placeholder');
SELECT pg_temp.want('"N / A" is the same word',      serial_problem('N / A'), 'placeholder');
SELECT pg_temp.want('none',                          serial_problem('None'), 'placeholder');
SELECT pg_temp.want('no serial #',                   serial_problem('No Serial #'), 'placeholder');
SELECT pg_temp.want('all zeros',                     serial_problem('0000'), 'placeholder');
SELECT pg_temp.want('all X',                         serial_problem('xxx'), 'placeholder');
SELECT pg_temp.want('punctuation only',              serial_problem('-?-'), 'needs letters or numbers');
SELECT pg_temp.want('blank',                         serial_problem('   '), 'blank');
SELECT pg_temp.want('a serial starting NA is real',  serial_problem('NA1234'), NULL::text);
SELECT pg_temp.want('leading zeros are real',        serial_problem('000123'), NULL::text);
SELECT pg_temp.want('X1 is real',                    serial_problem('X1'), NULL::text);
SELECT pg_temp.want('an FP number is real',          serial_problem('FP161340'), NULL::text);

-- ── Every write path refuses ────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a tech under Nate

SELECT pg_temp.want_error('a field ladder recorded as N/A is refused',
  $$SELECT record_inspection('{"serial_num":"N/A","work_order_id":"WO-SC","source":"field"}'::jsonb)$$);
SELECT pg_temp.want_error('… and as "none"',
  $$SELECT record_inspection('{"serial_num":"none","work_order_id":"WO-SC","source":"field"}'::jsonb)$$);
SELECT pg_temp.want_error('… and as punctuation',
  $$SELECT record_inspection('{"serial_num":"--","work_order_id":"WO-SC","source":"field"}'::jsonb)$$);
SELECT pg_temp.want_error('a batch with one placeholder writes nothing (Lia Office then retries row by row)',
  $$SELECT record_inspections('[{"serial_num":"SC-OK-1","work_order_id":"WO-SC"},{"serial_num":"UNKNOWN","work_order_id":"WO-SC"}]'::jsonb)$$);
SELECT pg_temp.want('… so the good row of that batch is not half-written',
  (SELECT count(*) FROM assets WHERE serial_key = 'SCOK1')::int, 0);
SELECT pg_temp.want_error('a fall-protection item recorded as N/A is refused',
  $$SELECT record_fp_inspection(jsonb_build_object('serial_num','n/a','manufacturer','MSA','model','V-FIT',
      'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',true))))$$);

DO $$
BEGIN
  PERFORM record_inspection('{"serial_num":"N/A","work_order_id":"WO-SC"}'::jsonb);
  RAISE EXCEPTION 'FAIL the refusal should have fired';
EXCEPTION WHEN check_violation THEN
  PERFORM pg_temp.want('the refusal is a check violation that says what to do',
    SQLERRM LIKE '"N/A" is not a serial number — use the number on the item, or a spare number%', true);
END $$;

-- A real serial still goes in, from the same tech, the same way.
SELECT record_inspection('{"serial_num":"NA-5501","work_order_id":"WO-SC","source":"field"}'::jsonb);
SELECT pg_temp.want('a real serial containing NA is recorded',
  (SELECT count(*) FROM ladder_inspections_public WHERE serial_key = 'NA5501')::int, 1);

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a lead
SELECT pg_temp.want_error('an office-added ladder as TBD is refused',
  $$SELECT add_inspection_office('{"serial_num":"TBD","work_order_id":"WO-SC","reason":"radioed in"}'::jsonb)$$);

-- Correcting a serial TO a placeholder is refused; correcting one AWAY is fine.
DO $$
DECLARE v_asset uuid;
BEGIN
  PERFORM record_fp_inspection(jsonb_build_object('serial_num','SC-FP-1','manufacturer','MSA','model','V-FIT',
    'checks', jsonb_build_array(jsonb_build_object('prompt','Labels?','result',true))));
  SELECT id INTO v_asset FROM assets WHERE serial_key = 'SCFP1';
  BEGIN
    PERFORM update_fp_asset(jsonb_build_object('asset_id', v_asset, 'serial_raw', 'N/A', 'reason', 'tag fell off'));
    RAISE EXCEPTION 'FAIL correcting a serial to N/A should be refused';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.want('correcting a serial to N/A is refused', true, true);
  END;
  PERFORM pg_temp.want('… and the item keeps its real serial',
    (SELECT serial_raw FROM assets WHERE id = v_asset), 'SC-FP-1');
END $$;

-- ── A placeholder that predates 39 ──────────────────────────────────────────
-- Inserted with the trigger off, as the live "NA" was before it was merged.
DO $$
DECLARE v_nate uuid; v_legacy uuid;
BEGIN
  SELECT account_id INTO v_nate FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002';
  ALTER TABLE assets DISABLE TRIGGER assets_serial_check_t;
  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
       VALUES (v_nate, 'fall_protection', 'NONE', 'NONE') RETURNING id INTO v_legacy;
  ALTER TABLE assets ENABLE TRIGGER assets_serial_check_t;

  UPDATE assets SET tag_label = 'FP999001' WHERE id = v_legacy;
  PERFORM pg_temp.want('a legacy placeholder row can still be tagged',
    (SELECT tag_label FROM assets WHERE id = v_legacy), 'FP999001');

  UPDATE assets SET serial_raw = 'SC-LEGACY-7', serial_key = serial_key('SC-LEGACY-7') WHERE id = v_legacy;
  PERFORM pg_temp.want('… and corrected to a real serial',
    (SELECT serial_key FROM assets WHERE id = v_legacy), 'SCLEGACY7');
END $$;

-- ── History import: the bad row is reported, the rest import ────────────────
DO $$
DECLARE v json;
BEGIN
  v := import_fp_history(jsonb_build_object('batch', 'serial check 39', 'rows', jsonb_build_array(
    jsonb_build_object('row', 2, 'serial', 'SC-H-1', 'inspection_date', '2025-02-01', 'result', 'pass'),
    jsonb_build_object('row', 3, 'serial', 'N/A',    'inspection_date', '2025-02-01', 'result', 'pass'),
    jsonb_build_object('row', 4, 'serial', 'SC-H-2', 'inspection_date', '2025-02-01', 'result', 'fail'))));
  PERFORM pg_temp.want('the two real rows import', (v->>'imported')::int, 2);
  PERFORM pg_temp.want('the N/A row is reported, by row', (v->'skipped'->0->>'row')::int, 3);
  PERFORM pg_temp.want('… with the reason', (v->'skipped'->0->>'reason') LIKE '"N/A" is not a serial number%', true);
END $$;

-- ── Destroyed ladders (40) ──────────────────────────────────────────────────
SELECT pg_temp.want('PMCD4 reads as repair cost prohibitive',
  ladder_destroy_reason('[{"name":"G13","qty":2},{"name":"PMCD4","qty":1}]'), 'Cut and destroyed: repair cost prohibitive');
SELECT pg_temp.want('the code is matched however it is typed',
  ladder_destroy_reason('[{"name":" pmcd-4 ","qty":1}]'), 'Cut and destroyed: repair cost prohibitive');
SELECT pg_temp.want('a specific reason beats the generic PMCD',
  ladder_destroy_reason('[{"name":"PMCD","qty":1},{"name":"PMCD5","qty":1}]'), 'Cut and destroyed: misuse or abuse');
SELECT pg_temp.want('TRL-3 is a destruction',
  ladder_destroy_reason('[{"name":"TRL-3","qty":1}]'), 'Destroyed and removed');
SELECT pg_temp.want('quantity 0 is not booked',
  ladder_destroy_reason('[{"name":"PMCD4","qty":0}]'), NULL::text);
SELECT pg_temp.want('repairs only is not a destruction',
  ladder_destroy_reason('[{"name":"G13","qty":2},{"name":"PM36","qty":1}]'), NULL::text);
SELECT pg_temp.want('no parts is not a destruction', ladder_destroy_reason(NULL), NULL::text);
SELECT pg_temp.want('a malformed parts value is not an error', ladder_destroy_reason('"PMCD4"'), NULL::text);
SELECT pg_temp.want('a plain-string part list works', ladder_destroy_reason('["PMCD2"]'), 'Cut and destroyed: ladder-rack damage');

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- the tech books it
SELECT record_inspection('{"serial_num":"SC-D-1","work_order_id":"WO-SC","source":"field","brand":"Werner","type":"Ext","length":"28","parts":[{"name":"PMCD4","qty":1}]}'::jsonb);
SELECT record_inspection('{"serial_num":"SC-D-2","work_order_id":"WO-SC","source":"field","parts":[{"name":"G13","qty":2}]}'::jsonb);

-- What a customer sees: anon, through the public view.
SET ROLE anon;
SELECT pg_temp.want('anon sees the destroyed ladder as destroyed',
  (SELECT destroyed FROM ladder_inspections_public WHERE serial_key = 'SCD1'), true);
SELECT pg_temp.want('… with the reason',
  (SELECT destroy_reason FROM ladder_inspections_public WHERE serial_key = 'SCD1'), 'Cut and destroyed: repair cost prohibitive');
SELECT pg_temp.want('a repaired ladder is not destroyed',
  (SELECT destroyed FROM ladder_inspections_public WHERE serial_key = 'SCD2'), false);
SELECT pg_temp.want('the work order lists one destroyed ladder',
  (SELECT count(*) FILTER (WHERE destroyed) FROM ladder_inspections_public WHERE work_order_id = 'WO-SC')::int, 1);
SELECT pg_temp.want('the parts themselves are not public',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'ladder_inspections_public' AND column_name = 'parts')::int, 0);
RESET ROLE;

-- A correction that takes the destroy part off un-destroys the ladder.
SET lia.uid = '1a000000-0000-0000-0000-000000000004';
SELECT record_inspection('{"serial_num":"SC-D-1","work_order_id":"WO-SC","source":"field","parts":[{"name":"G13","qty":1}]}'::jsonb);
SELECT pg_temp.want('a correction without the destroy part is not destroyed',
  (SELECT destroyed FROM ladder_inspections_public WHERE serial_key = 'SCD1'), false);
SELECT pg_temp.want('… and there is still exactly one current record',
  (SELECT count(*) FROM ladder_inspections_public WHERE serial_key = 'SCD1')::int, 1);
