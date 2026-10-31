-- Importing fall-protection history from the office (35).
-- Runs after 28_vehicle_inventory_test.sql.
--
-- Imported items are found by the phones (they are in account_snapshot); the
-- assigned number is the serial; history never displaces field work; nobody
-- is credited with an inspection they did not do; the due date is a year on;
-- a batch can be undone, and only cleanly.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/35_fp_history_import.sql
-- Twice: the paste is idempotent.
\ir ../migrations/35_fp_history_import.sql

DO $$
DECLARE
  v_nate    uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
  v_michael uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003');
  v_res     json;
  v_asset   uuid;
  v_n       integer;
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate, a lead

  -- A field record already on file for one of the items, on one of the dates.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_nate, 'fall_protection', 'BAT-0002', serial_key('BAT-0002')) RETURNING id INTO v_asset;
  INSERT INTO fp_inspections (account_id, asset_id, inspection_date, overall_pass, source, captured_at)
  VALUES (v_nate, v_asset, '2025-03-04', true, 'field', '2025-03-04T15:00:00Z');

  v_res := import_fp_history(jsonb_build_object('batch', 'batavia 2024-2025', 'rows', jsonb_build_array(
    jsonb_build_object('row', 2, 'serial', 'BAT-0001', 'inspection_date', '2025-01-15', 'result', 'Pass',
      'equipment_type', 'Body harness', 'manufacturer', 'MSA', 'model', 'V-FORM', 'mfr_serial', 'MSA-998877',
      'inspector', 'J. Ortiz', 'tag_label', 'FP170001', 'mfg_month', '6', 'mfg_year', '2021'),
    jsonb_build_object('row', 3, 'serial', 'BAT-0001', 'inspection_date', '2024-01-10', 'result', 'pass',
      'equipment_type', 'body_harness'),
    jsonb_build_object('row', 4, 'serial', 'BAT-0002', 'inspection_date', '2025-03-04', 'result', 'Fail'),
    jsonb_build_object('row', 5, 'serial', 'BAT-0003', 'inspection_date', '2025-02-01', 'result', 'Failed',
      'reason', 'Cut webbing', 'equipment_type', 'lanyard'),
    jsonb_build_object('row', 6, 'serial', '',         'inspection_date', '2025-02-01', 'result', 'Pass'),
    jsonb_build_object('row', 7, 'serial', 'BAT-0004', 'inspection_date', '01/02/2025', 'result', 'Pass'),
    jsonb_build_object('row', 8, 'serial', 'BAT-0005', 'inspection_date', '2025-02-01', 'result', 'maybe'),
    jsonb_build_object('row', 9, 'serial', 'BAT-0006', 'inspection_date', '2099-01-01', 'result', 'Pass'),
    jsonb_build_object('row',10, 'serial', 'BAT-0007', 'inspection_date', '2025-02-01', 'result', 'Pass',
      'equipment_type', 'trampoline'),
    jsonb_build_object('row',11, 'serial', 'BAT-0008', 'inspection_date', '2025-02-01', 'result', 'Pass',
      'tag_label', 'fp-170001')
  )));

  PERFORM pg_temp.want('the good rows land', (v_res->>'imported')::int, 4);
  PERFORM pg_temp.want('every bad row is reported, by its spreadsheet row',
    (SELECT array_agg((s->>'row')::int ORDER BY (s->>'row')::int) FROM json_array_elements(v_res->'skipped') s),
    ARRAY[4, 6, 7, 8, 9, 11]);
  PERFORM pg_temp.want('a row clashing with field work says why',
    (SELECT s->>'reason' FROM json_array_elements(v_res->'skipped') s WHERE (s->>'row')::int = 4),
    'Already has a record on 2025-03-04');
  PERFORM pg_temp.want('the field record is untouched — still current, still version 1',
    (SELECT count(*)::int FROM fp_inspections i JOIN assets a ON a.id = i.asset_id
      WHERE a.serial_key = 'BAT0002' AND i.is_current AND i.version = 1 AND i.source = 'field'), 1);
  PERFORM pg_temp.want('a tag already on another item is refused',
    (SELECT s->>'reason' FROM json_array_elements(v_res->'skipped') s WHERE (s->>'row')::int = 11),
    'Tag fp-170001 is already on another item');

  SELECT id INTO v_asset FROM assets WHERE account_id = v_nate AND serial_key = 'BAT0001';
  PERFORM pg_temp.want('the item is filed under its assigned number, in the account acting',
    (SELECT serial_raw || ' ' || kind FROM assets WHERE id = v_asset), 'BAT-0001 fall_protection');
  PERFORM pg_temp.want('two dates, two current records',
    (SELECT count(*)::int FROM fp_inspections WHERE asset_id = v_asset AND is_current), 2);
  PERFORM pg_temp.want('the manufacturer''s serial is kept, not matched on',
    (SELECT mfr_serial FROM fp_inspections WHERE asset_id = v_asset AND inspection_date = '2025-01-15'), 'MSA-998877');
  PERFORM pg_temp.want('the printed tag goes on the item',
    (SELECT tag_label FROM assets WHERE id = v_asset), 'FP170001');
  PERFORM pg_temp.want('the type resolves by name, and its catalogue name is stored',
    (SELECT item_type FROM fp_inspections WHERE asset_id = v_asset AND inspection_date = '2025-01-15'), 'Body harness');
  PERFORM pg_temp.want('no due date in the file: a year on',
    (SELECT next_due_date FROM fp_inspections WHERE asset_id = v_asset AND inspection_date = '2025-01-15'), date '2026-01-15');
  PERFORM pg_temp.want('credited to the file''s inspector, not to whoever imported it',
    (SELECT coalesce(collector_name,'') || '|' || coalesce(collected_by::text,'') || '|' || coalesce(tech_user_id::text,'')
       FROM fp_inspections WHERE asset_id = v_asset AND inspection_date = '2025-01-15'), 'J. Ortiz||');
  PERFORM pg_temp.want('and "Imported history" when the file names nobody',
    (SELECT collector_name FROM fp_inspections WHERE asset_id = v_asset AND inspection_date = '2024-01-10'), 'Imported history');
  PERFORM pg_temp.want('the certificate still names the lead',
    (SELECT rep_number FROM fp_inspections WHERE asset_id = v_asset AND inspection_date = '2025-01-15'), '734');
  PERFORM pg_temp.want('no checklist is invented',
    (SELECT count(*)::int FROM fp_inspection_checks c JOIN fp_inspections i ON i.id = c.fp_inspection_id
      WHERE i.asset_id = v_asset), 0);
  PERFORM pg_temp.want('a failure carries the file''s reason and fails',
    (SELECT discard_reason || ' / ' || status FROM fp_inspections i JOIN assets a ON a.id = i.asset_id
      WHERE a.serial_key = 'BAT0003'), 'Failed: Cut webbing / fail');
  PERFORM pg_temp.want('a type Lia does not know keeps the file''s words, with no checklist type',
    (SELECT coalesce(item_type,'') || '|' || coalesce(equipment_type_id::text,'') FROM fp_inspections i
       JOIN assets a ON a.id = i.asset_id WHERE a.serial_key = 'BAT0007'), 'trampoline|');
  PERFORM pg_temp.want('stamped with its batch',
    (SELECT count(*)::int FROM fp_inspections WHERE source = 'import:history:batavia 2024-2025'), 4);

  -- What the phone downloads: the item, its latest record.
  PERFORM pg_temp.want('the phones get the imported item, with its latest inspection',
    (SELECT last_inspected || ' ' || next_due || ' ' || item_type FROM account_snapshot() WHERE serial_key = 'BAT0001'),
    '2025-01-15 2026-01-15 Body harness');

  PERFORM pg_temp.want_error('a batch name with SQL in it is refused',
    $q$SELECT import_fp_history('{"batch":"x''; drop table assets;--","rows":[]}'::jsonb)$q$);
  PERFORM pg_temp.want_error('no rows is refused',
    $q$SELECT import_fp_history('{"batch":"empty"}'::jsonb)$q$);

  -- Re-running the same file adds nothing.
  v_res := import_fp_history(jsonb_build_object('batch', 'batavia 2024-2025 again', 'rows', jsonb_build_array(
    jsonb_build_object('serial', 'bat 0001', 'inspection_date', '2025-01-15', 'result', 'Pass'))));
  PERFORM pg_temp.want('a re-run matches by assigned number and skips what is there',
    (v_res->>'imported')::int, 0);

  PERFORM pg_temp.want('the office sees the batch',
    (SELECT records FROM fp_history_imports() WHERE batch = 'batavia 2024-2025'), 4);

  -- Michael cannot see or undo Nate's.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000003', true);
  PERFORM pg_temp.want('a sibling lists none of it',
    (SELECT count(*)::int FROM fp_history_imports()), 0);
  PERFORM pg_temp.want_error('nor undoes it',
    $q$SELECT undo_fp_history_import('batavia 2024-2025')$q$);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000004', true);   -- Nate's crew hand
  PERFORM pg_temp.want_error('a tech cannot import — it is the lead''s call',
    $q$SELECT import_fp_history('{"batch":"x","rows":[]}'::jsonb)$q$);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);

  -- Undo, refused once a record has been corrected.
  UPDATE fp_inspections SET bsi_pushed_at = now()
   WHERE source = 'import:history:batavia 2024-2025' AND inspection_date = '2024-01-10';
  PERFORM pg_temp.want_error('undo is refused once something has been billed',
    $q$SELECT undo_fp_history_import('batavia 2024-2025')$q$);
  UPDATE fp_inspections SET bsi_pushed_at = NULL
   WHERE source = 'import:history:batavia 2024-2025' AND inspection_date = '2024-01-10';

  PERFORM pg_temp.want_error('undo cannot reach a hand import such as Nate''s sheets',
    $q$SELECT undo_fp_history_import('nate-google-sheets-2026-09-28')$q$);

  v_res := undo_fp_history_import('batavia 2024-2025');
  PERFORM pg_temp.want('undo removes the batch',
    (v_res->>'records_removed')::int, 4);
  PERFORM pg_temp.want('and the items that were only ever the import',
    (SELECT count(*)::int FROM assets WHERE account_id = v_nate AND serial_key IN ('BAT0001','BAT0003','BAT0007')), 0);
  PERFORM pg_temp.want('the field record''s item stays',
    (SELECT count(*)::int FROM assets WHERE account_id = v_nate AND serial_key = 'BAT0002'), 1);
  PERFORM pg_temp.want('nothing of the batch is left',
    (SELECT count(*)::int FROM fp_inspections WHERE source LIKE 'import:history:batavia%'), 0);
  PERFORM pg_temp.want('Michael''s account was never touched',
    (SELECT count(*)::int FROM assets WHERE account_id = v_michael AND serial_key LIKE 'BAT%'), 0);
END $$;

-- anon may not call any of it.
SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot import', $q$SELECT public.import_fp_history('{}'::jsonb)$q$);
  PERFORM pg_temp.want_error('or undo', $q$SELECT public.undo_fp_history_import('x')$q$);
END $$;
RESET ROLE;
