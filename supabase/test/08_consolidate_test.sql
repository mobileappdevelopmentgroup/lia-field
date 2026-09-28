-- Consolidating onto one account. Runs last, because it deliberately reshapes
-- everything the earlier files set up.

\set ON_ERROR_STOP on
\ir _helpers.sql
\ir ../migrations/10_consolidate_account.sql
-- 29 re-emits the function with tag stock in it; the live database has both.
\ir ../migrations/29_fp_tag_stock_field.sql

-- Tag stock across a merge (29), seeded in two accounts other than the one
-- kept: a blank tag, and a tag on an item that has no certificate yet.
DO $$
DECLARE a1 uuid; a2 uuid; v_tagged uuid;
BEGIN
  SELECT id INTO a1 FROM accounts WHERE id <> (SELECT account_id FROM account_members
     WHERE user_id = '11111111-1111-1111-1111-111111111111') ORDER BY created_at LIMIT 1;
  SELECT id INTO a2 FROM accounts WHERE id NOT IN (a1, (SELECT account_id FROM account_members
     WHERE user_id = '11111111-1111-1111-1111-111111111111')) ORDER BY created_at LIMIT 1;

  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (a1, 'fall_protection', 'CONS-TAGGED', serial_key('CONS-TAGGED')) RETURNING id INTO v_tagged;

  INSERT INTO fp_tag_stock (account_id, tag_label, source) VALUES (a1, 'FPC00001', 'cons-test');
  INSERT INTO fp_tag_stock (account_id, tag_label, asset_id, source) VALUES (a1, 'FPC00002', v_tagged, 'cons-test');
  INSERT INTO fp_tag_stock (account_id, tag_label, source) VALUES (a2, 'FPC00003', 'cons-test');
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
