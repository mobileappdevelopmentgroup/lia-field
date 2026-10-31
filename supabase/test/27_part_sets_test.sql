-- Part sets the office publishes to the field.
-- Runs after 26_fp_photos_test.sql.
--
-- Same two directions as the parts list (24): sets flow DOWN from the umbrella
-- to every crew beneath it, and never sideways between subcontractors. And a
-- renamed set must stay the same set — phones key what they hold by its id.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/33_published_part_sets.sql

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate, a lead

SELECT save_account_part_sets('{"sets":[
  {"name":"Ford plant","parts":["G13","W44"," PM36 ",""]},
  {"name":"Hospital","parts":["L33","l33","W44"]}
]}'::jsonb);

DO $$
BEGIN
  PERFORM pg_temp.want('the lead''s sets are saved',
    (SELECT count(*)::int FROM account_part_sets_catalog()), 2);
  PERFORM pg_temp.want('in the order they were given',
    (SELECT string_agg(name, ',' ORDER BY ord) FROM account_part_sets_catalog()), 'Ford plant,Hospital');
  PERFORM pg_temp.want('parts trimmed, blanks dropped, button order kept',
    (SELECT parts FROM account_part_sets_catalog() WHERE name = 'Ford plant'), '["G13","W44","PM36"]'::jsonb);
  PERFORM pg_temp.want('the same part in another case is listed once',
    (SELECT parts FROM account_part_sets_catalog() WHERE name = 'Hospital'), '["L33","W44"]'::jsonb);
  PERFORM pg_temp.want('and they are the lead''s own',
    (SELECT bool_and(mine) FROM account_part_sets_catalog()), true);
  PERFORM pg_temp.want_error('two sets cannot share a name',
    'SELECT save_account_part_sets(''{"sets":[{"name":"A","parts":[]},{"name":" a ","parts":[]}]}''::jsonb)');
  PERFORM pg_temp.want_error('a set needs a name',
    'SELECT save_account_part_sets(''{"sets":[{"name":"  ","parts":[]}]}''::jsonb)');
  PERFORM pg_temp.want('and a refused save changed nothing',
    (SELECT count(*)::int FROM account_part_sets_catalog()), 2);
END $$;

-- ── Renaming keeps the set; leaving one out removes it ──────────────────────
DO $$
DECLARE v_ford uuid; v_hosp uuid;
BEGIN
  SELECT id INTO v_ford FROM account_part_sets_catalog() WHERE name = 'Ford plant';
  SELECT id INTO v_hosp FROM account_part_sets_catalog() WHERE name = 'Hospital';
  PERFORM save_account_part_sets(jsonb_build_object('sets', jsonb_build_array(
    jsonb_build_object('id', v_ford, 'name', 'Ford — Dearborn', 'parts', '["W44"]'::jsonb))));
  PERFORM pg_temp.want('a renamed set keeps its id',
    (SELECT id FROM account_part_sets_catalog() WHERE name = 'Ford — Dearborn'), v_ford);
  PERFORM pg_temp.want('with its new parts',
    (SELECT parts FROM account_part_sets_catalog() WHERE id = v_ford), '["W44"]'::jsonb);
  PERFORM pg_temp.want('a set left out is no longer published',
    (SELECT count(*)::int FROM account_part_sets_catalog() WHERE id = v_hosp), 0);
  PERFORM pg_temp.want('but is kept, marked deleted',
    (SELECT is_deleted FROM account_part_sets WHERE id = v_hosp), true);
END $$;

-- A deleted name can be used again.
SELECT save_account_part_sets(jsonb_build_object('sets', jsonb_build_array(
  jsonb_build_object('id', (SELECT id FROM account_part_sets_catalog() WHERE name = 'Ford — Dearborn'),
                     'name', 'Ford — Dearborn', 'parts', '["W44"]'::jsonb),
  jsonb_build_object('name', 'Hospital', 'parts', '["L33"]'::jsonb))));
DO $$
BEGIN
  PERFORM pg_temp.want('a deleted set''s name can be used again',
    (SELECT parts FROM account_part_sets_catalog() WHERE name = 'Hospital'), '["L33"]'::jsonb);
END $$;

-- ── The crew gets them, and cannot change them ──────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- a tech under Nate
DO $$
BEGIN
  PERFORM pg_temp.want('a tech gets their lead''s sets',
    (SELECT count(*)::int FROM account_part_sets_catalog()), 2);
  PERFORM pg_temp.want_error('but cannot publish',
    'SELECT save_account_part_sets(''{"sets":[{"name":"Mine","parts":[]}]}''::jsonb)');
END $$;

-- ── Not sideways ────────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael, another company
DO $$
BEGIN
  PERFORM pg_temp.want('a different company sees none of them',
    (SELECT count(*)::int FROM account_part_sets_catalog() WHERE name IN ('Ford — Dearborn','Hospital')), 0);
END $$;
-- The table itself, as the API role sees it: row security, not just the RPC.
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('nor through the table',
    (SELECT count(*)::int FROM account_part_sets WHERE name IN ('Ford — Dearborn','Hospital')), 0);
  PERFORM pg_temp.want_error('and nobody writes the table directly',
    $q$ UPDATE account_part_sets SET name = 'x' $q$);
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  PERFORM pg_temp.want_error('anon cannot reach the sets', $q$ SELECT count(*) FROM account_part_sets $q$);
END $$;
RESET ROLE;

-- ── Down from the umbrella ──────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- Batavia's office
SELECT save_account_part_sets('{"sets":[{"name":"Batavia standard","parts":["G13"]}]}'::jsonb);

SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael
DO $$
BEGIN
  PERFORM pg_temp.want('a subcontractor inherits the umbrella''s set',
    (SELECT count(*)::int FROM account_part_sets_catalog() WHERE name = 'Batavia standard'), 1);
  PERFORM pg_temp.want('marked as not their own, so their office cannot edit it',
    (SELECT mine FROM account_part_sets_catalog() WHERE name = 'Batavia standard'), false);
END $$;

-- Saving a subcontractor's own list never touches the umbrella's, even if the
-- umbrella's set id is sent back: it becomes a set of the sub's own.
DO $$
BEGIN
  PERFORM save_account_part_sets(jsonb_build_object('sets', jsonb_build_array(
    jsonb_build_object('id', (SELECT id FROM account_part_sets_catalog() WHERE name = 'Batavia standard'),
                       'name', 'Batavia standard', 'parts', '["W44"]'::jsonb))));
  PERFORM pg_temp.want('the umbrella''s set is untouched',
    (SELECT parts FROM account_part_sets WHERE name = 'Batavia standard' AND NOT is_deleted
       AND account_id = (SELECT account_id FROM account_members
                          WHERE user_id = '1a000000-0000-0000-0000-000000000001')), '["G13"]'::jsonb);
  PERFORM save_account_part_sets('{"sets":[]}'::jsonb);
END $$;

SET lia.uid = '1a000000-0000-0000-0000-000000000004';   -- Nate's tech
DO $$
BEGIN
  PERFORM pg_temp.want('a crew sees its own lead''s sets first, then the umbrella''s',
    (SELECT string_agg(name, ',' ORDER BY NOT mine, ord) FROM account_part_sets_catalog()),
    'Ford — Dearborn,Hospital,Batavia standard');
END $$;
