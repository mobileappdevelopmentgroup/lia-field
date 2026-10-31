-- Spare numbers that are also tags, and numbers the sheet says are used (37).
-- Runs after 30_fp_serial_pool_test.sql.
--
-- Shaped on the first real list (Nate, 2026-10-15): his own tag numbers, some
-- blank in tag stock, some the tag label of an item with a certificate, some
-- filled in on the sheet with nothing in Lia.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/37_fp_serial_pool_tags.sql
-- Twice: the paste is idempotent.
\ir ../migrations/37_fp_serial_pool_tags.sql

DO $$
DECLARE
  v_nate    uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
  v_michael uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003');
  v_crew    uuid := '1a000000-0000-0000-0000-000000000004';
  v_res     json;
  v_a       text[];
BEGIN
  -- FP7001 is the tag label of an item whose serial is the manufacturer's.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_label)
  VALUES (v_nate, 'fall_protection', '8291761', serial_key('8291761'), 'FP7001');
  -- FP7003–FP7006 are blank tags in Nate's stock; Michael holds his own FP7004.
  INSERT INTO fp_tag_stock (account_id, tag_label, tag_url, source) VALUES
    (v_nate, 'FP7003', 'https://docs.google.com/spreadsheets/d/a', 'pool-tags-test'),
    (v_nate, 'FP7004', 'https://docs.google.com/spreadsheets/d/b', 'pool-tags-test'),
    (v_nate, 'FP7005', 'https://docs.google.com/spreadsheets/d/c', 'pool-tags-test'),
    (v_nate, 'FP7006', 'https://docs.google.com/spreadsheets/d/d', 'pool-tags-test'),
    (v_michael, 'FP7004', 'https://docs.google.com/spreadsheets/d/m', 'pool-tags-test');

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  v_res := add_fp_serial_pool(jsonb_build_object('source', 'nate sheet 1',
    'used',    jsonb_build_array('FP7001', 'FP7002', 'FP7003'),
    'serials', jsonb_build_array('FP7004', 'FP7005', 'FP7006', 'FP7007', 'FP7002')));
  PERFORM pg_temp.want('the item carrying FP7001 as its tag label is found',
    (v_res->>'already_on_an_item')::int, 1);
  PERFORM pg_temp.want('what the sheet says is spent goes in used',
    (v_res->>'used_on_sheet')::int, 2);
  PERFORM pg_temp.want('the rest are free', (v_res->>'added')::int, 4);
  PERFORM pg_temp.want('a number listed both ways counts once, as used', (v_res->>'already_listed')::int, 1);
  PERFORM pg_temp.want('the blank tags leave Nate''s stock', (v_res->>'taken_from_tag_stock')::int, 4);
  PERFORM pg_temp.want('none of them is left as a blank tag',
    (SELECT count(*)::int FROM fp_tag_stock WHERE account_id = v_nate AND source = 'pool-tags-test'), 0);
  PERFORM pg_temp.want('Michael''s own FP7004 is untouched',
    (SELECT count(*)::int FROM fp_tag_stock WHERE account_id = v_michael AND tag_label = 'FP7004'), 1);
  PERFORM pg_temp.want('the tagged item is linked to its number',
    (SELECT asset_id IS NOT NULL FROM fp_serial_pool WHERE account_id = v_nate AND serial_key = 'FP7001'), true);

  -- A phone is only ever handed the free ones.
  PERFORM set_config('lia.uid', v_crew::text, true);
  SELECT array_agg(serial ORDER BY serial) INTO v_a FROM reserve_fp_serials(20);
  PERFORM pg_temp.want('a phone never gets a number on an item or spent on the sheet',
    (SELECT array_agg(x ORDER BY x) FROM unnest(v_a) x WHERE x LIKE 'FP7%'),
    ARRAY['FP7004', 'FP7005', 'FP7006', 'FP7007']);

  -- The next sheet says FP7005 has been spent, while the phone holds it.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);
  v_res := add_fp_serial_pool('{"used":["FP7005"],"serials":["FP7006"]}'::jsonb);
  PERFORM pg_temp.want('a later sheet marks a held number spent',
    (v_res->>'now_used')::int || '/' || (v_res->>'already_listed')::int, '1/1');
  PERFORM set_config('lia.uid', v_crew::text, true);
  PERFORM pg_temp.want('and the phone stops being given it',
    (SELECT count(*)::int FROM reserve_fp_serials(20) r WHERE r.serial = 'FP7005'), 0);

  -- An item given a free number as its TAG LABEL uses it, by any write path.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_label)
  VALUES (v_nate, 'fall_protection', 'MFR-77', serial_key('MFR-77'), 'FP7007');
  PERFORM pg_temp.want('a number put on an item as a tag label is used',
    (SELECT asset_id IS NOT NULL FROM fp_serial_pool WHERE account_id = v_nate AND serial_key = 'FP7007'), true);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);
  PERFORM pg_temp.want('the office counts sheet-spent numbers as used',
    (SELECT count(*)::int FROM fp_serial_pool
      WHERE account_id = v_nate AND serial_key LIKE 'FP7%' AND (asset_id IS NOT NULL OR used_at IS NOT NULL)), 5);

  -- 36's callers send only `serials`: still accepted.
  v_res := add_fp_serial_pool('{"serials":["FP7008"]}'::jsonb);
  PERFORM pg_temp.want('a list with no used numbers still loads', (v_res->>'added')::int, 1);
  PERFORM pg_temp.want_error('used must be a list',
    $q$SELECT add_fp_serial_pool('{"serials":[],"used":"FP1"}'::jsonb)$q$);
END $$;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon still cannot load', $q$SELECT public.add_fp_serial_pool('{"serials":[]}'::jsonb)$q$);
  PERFORM pg_temp.want_error('or reserve', $q$SELECT * FROM public.reserve_fp_serials(1)$q$);
END $$;
RESET ROLE;
