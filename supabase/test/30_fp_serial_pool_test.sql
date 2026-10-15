-- Numbers for untagged defective equipment (36).
-- Runs after 29_fp_history_import_test.sql.
--
-- The office loads the spreadsheet; a phone reserves a few numbers and spends
-- them offline; two phones never hold the same number; a number given to an
-- item is used whatever wrote the item; nobody outside the account sees them.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/36_fp_serial_pool.sql
-- Twice: the paste is idempotent.
\ir ../migrations/36_fp_serial_pool.sql

DO $$
DECLARE
  v_nate    uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
  v_crew    uuid := '1a000000-0000-0000-0000-000000000004';
  v_res     json;
  v_a       text[];
  v_b       text[];
BEGIN
  PERFORM pg_temp.want('the crew hand is on Nate''s crew',
    (SELECT account_id FROM account_members WHERE user_id = v_crew AND removed_at IS NULL), v_nate);

  -- One number is already on an item: it goes in as used, never handed out.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_nate, 'fall_protection', 'UT-0003', serial_key('UT-0003'));

  PERFORM set_config('lia.uid', v_crew::text, true);
  PERFORM pg_temp.want_error('a tech cannot load numbers',
    $q$SELECT add_fp_serial_pool('{"serials":["UT-9"]}'::jsonb)$q$);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate, a lead
  v_res := add_fp_serial_pool(jsonb_build_object('source', 'Batavia spreadsheet',
    'serials', jsonb_build_array('UT-0010', 'UT-0001', 'UT-0002', 'ut 0002', 'UT-0003', '', 'UT-0004',
                                 'UT-0005', 'UT-0006', 'UT-0007', 'UT-0008', 'UT-0009', 'UT-0011')));
  PERFORM pg_temp.want('new numbers are added', (v_res->>'added')::int, 10);
  PERFORM pg_temp.want('a repeat in the file counts once', (v_res->>'already_listed')::int, 1);
  PERFORM pg_temp.want('one already on an item is noted', (v_res->>'already_on_an_item')::int, 1);
  v_res := add_fp_serial_pool('{"serials":["UT-0001","UT-0012"]}'::jsonb);
  PERFORM pg_temp.want('loading again adds only what is new',
    (v_res->>'added')::int || '/' || (v_res->>'already_listed')::int, '1/1');

  -- The crew hand's phone reserves.
  PERFORM set_config('lia.uid', v_crew::text, true);
  SELECT array_agg(serial ORDER BY serial) INTO v_a FROM reserve_fp_serials(3);
  PERFORM pg_temp.want('a phone gets the lowest free numbers, never the used one',
    v_a, ARRAY['UT-0001', 'UT-0002', 'UT-0004']);
  SELECT array_agg(serial ORDER BY serial) INTO v_a FROM reserve_fp_serials(3);
  PERFORM pg_temp.want('asking again tops up, it does not take more', v_a, ARRAY['UT-0001', 'UT-0002', 'UT-0004']);

  -- Nate's own phone reserves too: different numbers.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);
  SELECT array_agg(serial ORDER BY serial) INTO v_b FROM reserve_fp_serials(3);
  PERFORM pg_temp.want('a second phone never gets the first one''s numbers', v_b, ARRAY['UT-0005', 'UT-0006', 'UT-0007']);

  -- The crew hand records a defective item under one, by the ordinary write path.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_nate, 'fall_protection', 'UT-0002', serial_key('UT-0002'));
  PERFORM pg_temp.want('giving an item the number uses it',
    (SELECT asset_id IS NOT NULL AND used_at IS NOT NULL FROM fp_serial_pool WHERE account_id = v_nate AND serial_key = 'UT0002'), true);

  PERFORM set_config('lia.uid', v_crew::text, true);
  SELECT array_agg(serial ORDER BY serial) INTO v_a FROM reserve_fp_serials(3);
  PERFORM pg_temp.want('and the phone is topped up past it, in natural order (9 before 10)',
    v_a, ARRAY['UT-0001', 'UT-0004', 'UT-0008']);
  SELECT array_agg(serial ORDER BY serial) INTO v_a FROM reserve_fp_serials(50);
  PERFORM pg_temp.want('a phone can hold at most 20; here it takes what is left',
    array_length(v_a, 1), 3 + 4);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);
  v_res := fp_serial_pool_summary();
  PERFORM pg_temp.want('the office sees free / reserved / used',
    (v_res->>'free') || '/' || (v_res->>'reserved') || '/' || (v_res->>'used'), '0/10/2');
  PERFORM pg_temp.want('and who holds what', json_array_length(v_res->'holders'), 2);

  -- Somebody leaving the crew gives their numbers back.
  UPDATE account_members SET removed_at = now() WHERE user_id = v_crew;
  PERFORM reserve_fp_serials(3);
  PERFORM pg_temp.want('a removed tech''s numbers return to the pool',
    (fp_serial_pool_summary()->>'free')::int, 7);
  UPDATE account_members SET removed_at = NULL WHERE user_id = v_crew;

  -- Michael's account sees none of it.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000003', true);
  PERFORM pg_temp.want('another lead''s phone gets nothing from Nate''s pool',
    (SELECT count(*)::int FROM reserve_fp_serials(5)), 0);
END $$;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot load', $q$SELECT public.add_fp_serial_pool('{"serials":[]}'::jsonb)$q$);
  PERFORM pg_temp.want_error('or reserve', $q$SELECT * FROM public.reserve_fp_serials(1)$q$);
  PERFORM pg_temp.want_error('or read the pool', $q$SELECT * FROM public.fp_serial_pool$q$);
END $$;
RESET ROLE;
