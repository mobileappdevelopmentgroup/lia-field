-- Consolidating onto one account. Runs last, because it deliberately reshapes
-- everything the earlier files set up.

\set ON_ERROR_STOP on
\ir _helpers.sql
\ir ../migrations/10_consolidate_account.sql
-- 29 and 30 re-emit the function; the live database has all three.
\ir ../migrations/29_fp_tag_stock_field.sql
\ir ../migrations/30_consolidate_fold_first.sql

-- ── Refuses while companies sit under an umbrella (30) ──────────────────────
-- 16_umbrella_test left accounts arranged under Batavia. Merging them would
-- put one company's records in another's, so it must not even start.
DO $$ BEGIN
  PERFORM pg_temp.want_error('consolidation refuses while accounts sit under an umbrella',
    $q$ SELECT consolidate_to_one_account('11111111-1111-1111-1111-111111111111') $q$);
  PERFORM pg_temp.want('and changes nothing when it does',
    (SELECT count(*)::int > 1 FROM accounts), true);
END $$;
UPDATE accounts SET parent_account_id = NULL;

-- ── What a merge has to carry across (30) ───────────────────────────────────
-- Seeded in two accounts other than the one kept:
--   * the SAME ladder serial and the SAME fall-protection serial in both, each
--     with a current record on the same day — the case that used to fail;
--   * a tag written onto the later fall-protection item, a tag link seen by
--     both, tag stock, a job on the same work order in both, a known network.
DO $$
DECLARE a1 uuid; a2 uuid; l1 uuid; l2 uuid; f1 uuid; f2 uuid; w1 uuid; w2 uuid; j1 uuid; j2 uuid; v_tagged uuid;
BEGIN
  SELECT id INTO a1 FROM accounts WHERE id <> (SELECT account_id FROM account_members
     WHERE user_id = '11111111-1111-1111-1111-111111111111') ORDER BY created_at LIMIT 1;
  SELECT id INTO a2 FROM accounts WHERE id NOT IN (a1, (SELECT account_id FROM account_members
     WHERE user_id = '11111111-1111-1111-1111-111111111111')) ORDER BY created_at LIMIT 1;

  INSERT INTO assets (account_id, kind, serial_raw, serial_key, created_at)
  VALUES (a1, 'ladder', 'CONS-L', serial_key('CONS-L'), now() - interval '2 days') RETURNING id INTO l1;
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_label)
  VALUES (a2, 'ladder', 'CONS-L', serial_key('CONS-L'), 'LBL-FROM-LOSER') RETURNING id INTO l2;
  INSERT INTO inspections (account_id, asset_id, serial_num, inspection_date, tech_name, created_at)
  VALUES (a1, l1, 'CONS-L', '2026-09-01', 'A', now() - interval '1 hour'),
         (a2, l2, 'CONS-L', '2026-09-01', 'B', now());

  INSERT INTO assets (account_id, kind, serial_raw, serial_key, created_at)
  VALUES (a1, 'fall_protection', 'CONS-F', serial_key('CONS-F'), now() - interval '2 days') RETURNING id INTO f1;
  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (a2, 'fall_protection', 'CONS-F', serial_key('CONS-F')) RETURNING id INTO f2;
  INSERT INTO fp_inspections (account_id, asset_id, inspection_date, created_at)
  VALUES (a1, f1, '2026-09-02', now() - interval '1 hour'), (a2, f2, '2026-09-02', now());
  INSERT INTO fp_tag_writes (account_id, asset_id, tag_label, tag_url)
  VALUES (a2, f2, 'FPC00009', 'https://lia.test/fp/?t=X');
  INSERT INTO fp_tag_links (account_id, tag_url, seen_count) VALUES
    (a1, 'https://docs.google.com/spreadsheets/d/consLink/edit', 2),
    (a2, 'https://docs.google.com/spreadsheets/d/consLink/edit', 3);

  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (a1, 'fall_protection', 'CONS-TAGGED', serial_key('CONS-TAGGED')) RETURNING id INTO v_tagged;
  INSERT INTO fp_tag_stock (account_id, tag_label, source) VALUES (a1, 'FPC00001', 'cons-test');
  INSERT INTO fp_tag_stock (account_id, tag_label, asset_id, source) VALUES (a1, 'FPC00002', v_tagged, 'cons-test');
  INSERT INTO fp_tag_stock (account_id, tag_label, asset_id, source) VALUES (a2, 'FPC00003', f2, 'cons-test');

  INSERT INTO work_orders (account_id, wo_number, wo_key) VALUES (a1, 'CONS-77', 'CONS77') RETURNING id INTO w1;
  INSERT INTO work_orders (account_id, wo_number, wo_key) VALUES (a2, 'CONS-77', 'CONS77') RETURNING id INTO w2;
  INSERT INTO fp_inspections (account_id, asset_id, inspection_date, work_order_uuid) VALUES (a2, f2, '2026-09-03', w2);
  INSERT INTO jobs (account_id, work_order_uuid, wo_number, wo_key) VALUES (a1, w1, 'CONS-77', 'CONS77') RETURNING id INTO j1;
  INSERT INTO jobs (account_id, work_order_uuid, wo_number, wo_key) VALUES (a2, w2, 'CONS-77', 'CONS77') RETURNING id INTO j2;
  INSERT INTO job_assignees (job_id, user_id) VALUES
    (j1, (SELECT user_id FROM account_members WHERE account_id = a1 LIMIT 1)),
    (j2, (SELECT user_id FROM account_members WHERE account_id = a2 LIMIT 1));

  INSERT INTO known_networks (account_id, cidr, label) VALUES (a2, '10.9.9.0/24', 'cons office');
END $$;

DO $$
DECLARE v_before_accounts int; v_before_insp int; v_res json;
BEGIN
  SELECT count(*)::int INTO v_before_accounts FROM accounts;
  SELECT count(*)::int INTO v_before_insp FROM inspections;
  PERFORM pg_temp.want('more than one account before consolidating', v_before_accounts > 1, true);

  v_res := consolidate_to_one_account('11111111-1111-1111-1111-111111111111', 'Batavia');

  PERFORM pg_temp.want('one account afterwards', (SELECT count(*)::int FROM accounts), 1);
  PERFORM pg_temp.want('it is named', (SELECT name FROM accounts LIMIT 1), 'Batavia');
  -- Nothing may be lost: these are records of safety inspections.
  PERFORM pg_temp.want('every inspection survives',
    (SELECT count(*)::int FROM inspections), v_before_insp);
  PERFORM pg_temp.want('and none is left ownerless',
    (SELECT count(*)::int FROM inspections WHERE account_id IS NULL), 0);
  PERFORM pg_temp.want('fall protection too',
    (SELECT count(*)::int FROM fp_inspections WHERE account_id IS NULL), 0);

  PERFORM pg_temp.want('the nominated user leads',
    (SELECT role FROM account_members WHERE user_id='11111111-1111-1111-1111-111111111111'), 'lead');
  PERFORM pg_temp.want('everyone else collects',
    (SELECT count(*)::int FROM account_members WHERE role='tech' AND desktop_access), 0);

  -- An unlimited balance anywhere must not be downgraded to a number.
  PERFORM pg_temp.want('unlimited credit is preserved',
    (SELECT credits FROM accounts LIMIT 1), -1);

  PERFORM pg_temp.want('two accounts holding the same ladder serial no longer stop it',
    (SELECT count(*)::int FROM assets WHERE serial_raw = 'CONS-L'), 1);
  PERFORM pg_temp.want('both ladder records survive on the one item',
    (SELECT count(*)::int FROM inspections WHERE serial_num = 'CONS-L'), 2);
  PERFORM pg_temp.want('with one of them current for the day — the newer',
    (SELECT tech_name FROM inspections WHERE serial_num = 'CONS-L' AND is_current), 'B');
  PERFORM pg_temp.want('and their versions renumbered rather than colliding',
    (SELECT array_agg(version ORDER BY version) FROM inspections WHERE serial_num = 'CONS-L'), ARRAY[1,2]);
  PERFORM pg_temp.want('the survivor takes a tag label only the other one had',
    (SELECT tag_label FROM assets WHERE serial_raw = 'CONS-L'), 'LBL-FROM-LOSER');
  PERFORM pg_temp.want('the same fall-protection serial folds too',
    (SELECT count(*)::int FROM assets WHERE serial_raw = 'CONS-F'), 1);
  PERFORM pg_temp.want('keeping all three of its records',
    (SELECT count(*)::int FROM fp_inspections f JOIN assets a ON a.id = f.asset_id WHERE a.serial_raw = 'CONS-F'), 3);
  PERFORM pg_temp.want('one current per day',
    (SELECT count(*)::int FROM fp_inspections f JOIN assets a ON a.id = f.asset_id
      WHERE a.serial_raw = 'CONS-F' AND f.inspection_date = '2026-09-02' AND f.is_current), 1);
  PERFORM pg_temp.want('the tag written on the folded-away item is kept, on the survivor',
    (SELECT a.serial_raw FROM fp_tag_writes w JOIN assets a ON a.id = w.asset_id WHERE w.tag_label = 'FPC00009'), 'CONS-F');
  PERFORM pg_temp.want('and its tag-stock row follows it rather than going back to blank',
    (SELECT a.serial_raw FROM fp_tag_stock s JOIN assets a ON a.id = s.asset_id WHERE s.tag_label = 'FPC00003'), 'CONS-F');
  PERFORM pg_temp.want('a link seen by both is one link, its sightings added',
    (SELECT array_agg(seen_count) FROM fp_tag_links WHERE tag_url LIKE '%consLink%'), ARRAY[5]);
  PERFORM pg_temp.want('the work order both held is one work order',
    (SELECT count(*)::int FROM work_orders WHERE wo_key = 'CONS77'), 1);
  PERFORM pg_temp.want('with the fall-protection record re-pointed at it, not left dangling',
    (SELECT f.work_order_uuid = w.id FROM fp_inspections f, work_orders w
      WHERE f.inspection_date = '2026-09-03' AND w.wo_key = 'CONS77'), true);
  PERFORM pg_temp.want('one job for it',
    (SELECT count(*)::int FROM jobs WHERE wo_key = 'CONS77'), 1);
  PERFORM pg_temp.want('carrying both companies'' assignees',
    (SELECT count(*)::int FROM job_assignees ja JOIN jobs j ON j.id = ja.job_id WHERE j.wo_key = 'CONS77'), 2);
  PERFORM pg_temp.want('a known network is not deleted with its old account',
    (SELECT count(*)::int FROM known_networks WHERE label = 'cons office'), 1);
  PERFORM pg_temp.want('tag stock moves with everything else',
    (SELECT count(*)::int FROM fp_tag_stock WHERE source = 'cons-test'
        AND account_id = (SELECT id FROM accounts LIMIT 1)), 3);
  PERFORM pg_temp.want('a blank tag stays blank',
    (SELECT asset_id FROM fp_tag_stock WHERE tag_label = 'FPC00001'), NULL::uuid);
  PERFORM pg_temp.want('an item with a tag and no certificate yet is kept',
    (SELECT a.serial_raw FROM fp_tag_stock s JOIN assets a ON a.id = s.asset_id
      WHERE s.tag_label = 'FPC00002'), 'CONS-TAGGED');
END $$;

-- Two accounts may each hold the same work order number — that namespacing is
-- the whole point of UNIQUE (account, wo_key). Merging them must fold the
-- duplicates rather than fail, and must not leave the number charged twice.
DO $$ BEGIN
  PERFORM pg_temp.want('duplicate work order numbers were folded',
    (SELECT count(*)::int FROM (
      SELECT wo_key FROM work_orders GROUP BY 1 HAVING count(*) > 1) x), 0);
  PERFORM pg_temp.want('and the charged one survived',
    (SELECT charged_at IS NOT NULL FROM work_orders
      WHERE wo_key = 'WO12345'), true);
END $$;

-- Consolidating merges serial namespaces, which can create collisions that were
-- legitimately distinct before. The partial unique index would reject those.
DO $$ BEGIN
  PERFORM pg_temp.want('no two current inspections share an item and a date',
    (SELECT count(*)::int FROM (
      SELECT asset_id, inspection_date FROM inspections
       WHERE is_current AND NOT is_deleted GROUP BY 1,2 HAVING count(*) > 1) x), 0);
  PERFORM pg_temp.want('and no asset is duplicated within the account',
    (SELECT count(*)::int FROM (
      SELECT kind, serial_key FROM assets GROUP BY 1,2 HAVING count(*) > 1) x), 0);
END $$;

-- The point of consolidating: techs share one catalogue, which is what makes
-- multi-tech merge possible at all.
DO $$
DECLARE v_lead int; v_sub int;
BEGIN
  PERFORM set_config('lia.uid', '11111111-1111-1111-1111-111111111111', false);
  SELECT count(*)::int INTO v_lead FROM account_snapshot();
  PERFORM set_config('lia.uid', '33333333-3333-3333-3333-333333333333', false);
  SELECT count(*)::int INTO v_sub FROM account_snapshot();
  PERFORM pg_temp.want('a sub-tech sees the same catalogue as the lead', v_sub, v_lead);
  PERFORM pg_temp.want('and it is not empty', v_lead > 0, true);
END $$;

-- A sub-tech still must not be able to author.
SET lia.uid = '33333333-3333-3333-3333-333333333333';
DO $$ BEGIN
  PERFORM pg_temp.want_error('a sub-tech still cannot change the catalogue',
    $q$ SELECT save_fp_model('{"manufacturer":"X","model":"Y"}'::jsonb) $q$);
END $$;

-- Re-running must not damage anything.
SET lia.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE v_insp int;
BEGIN
  SELECT count(*)::int INTO v_insp FROM inspections;
  PERFORM consolidate_to_one_account('11111111-1111-1111-1111-111111111111');
  PERFORM pg_temp.want('re-running changes nothing', (SELECT count(*)::int FROM inspections), v_insp);
  PERFORM pg_temp.want('and still one account', (SELECT count(*)::int FROM accounts), 1);
END $$;

DO $$ BEGIN
  PERFORM pg_temp.want_error('a user with no account cannot be nominated',
    $q$ SELECT consolidate_to_one_account('00000000-0000-0000-0000-000000000000') $q$);
END $$;

SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot consolidate anything',
    $q$ SELECT consolidate_to_one_account('11111111-1111-1111-1111-111111111111') $q$);
END $$;
RESET ROLE;

\echo ''
\echo 'All consolidation assertions passed.'
