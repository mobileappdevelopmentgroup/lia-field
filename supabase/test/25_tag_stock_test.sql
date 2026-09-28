-- Tags a lead holds before they are put on anything.
-- Runs after 24_shared_parts_test.sql.
--
-- A stocked tag is not an asset and never becomes one by being stocked. It
-- leaves stock when an asset in the same account is given its label or link,
-- by whatever path; and stock, like work, is seen upward and never sideways.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/28_fp_tag_stock.sql
\ir ../migrations/29_fp_tag_stock_field.sql

DO $$
DECLARE
  v_nate    uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
  v_michael uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003');
  v_assets  int  := (SELECT count(*) FROM assets);
BEGIN
  INSERT INTO fp_tag_stock (account_id, holder_user_id, tag_label, tag_url, source) VALUES
    (v_nate, '1a000000-0000-0000-0000-000000000002', 'FP900001',
     'https://docs.google.com/spreadsheets/d/stockA/edit?usp=drivesdk', 'test'),
    (v_nate, '1a000000-0000-0000-0000-000000000002', 'FP900002',
     'https://docs.google.com/spreadsheets/d/stockB/edit?usp=drivesdk', 'test'),
    (v_nate, NULL, 'FP900003', NULL, 'test'),
    -- The same label in another company is a different tag.
    (v_michael, NULL, 'FP900001', NULL, 'test');

  PERFORM pg_temp.want('stocking tags creates no assets', (SELECT count(*)::int FROM assets), v_assets);
  PERFORM pg_temp.want('stocked tags start unassigned',
    (SELECT count(*)::int FROM fp_tag_stock WHERE source = 'test' AND asset_id IS NULL), 4);

  -- By label.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_label)
  VALUES (v_nate, 'fall_protection', 'STK-1', serial_key('STK-1'), 'fp-900001');
  PERFORM pg_temp.want('a tag leaves stock when an item takes its label',
    (SELECT a.serial_raw FROM fp_tag_stock s JOIN assets a ON a.id = s.asset_id
      WHERE s.account_id = v_nate AND s.tag_label = 'FP900001'), 'STK-1');
  PERFORM pg_temp.want('and is stamped with when',
    (SELECT assigned_at IS NOT NULL FROM fp_tag_stock WHERE account_id = v_nate AND tag_label = 'FP900001'), true);
  PERFORM pg_temp.want('another company''s tag with the same label is untouched',
    (SELECT asset_id FROM fp_tag_stock WHERE account_id = v_michael AND tag_label = 'FP900001'), NULL::uuid);

  -- By link, set after the fact (the tag-url trigger and tag writes both UPDATE).
  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_nate, 'fall_protection', 'STK-2', serial_key('STK-2'));
  UPDATE assets SET tag_url = 'https://DOCS.google.com/spreadsheets/d/stockB/edit?usp=drivesdk'
   WHERE serial_raw = 'STK-2';
  PERFORM pg_temp.want('or its link, however the link is cased',
    (SELECT a.serial_raw FROM fp_tag_stock s JOIN assets a ON a.id = s.asset_id
      WHERE s.tag_label = 'FP900002'), 'STK-2');

  -- A ladder is never a fall-protection tag's home.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_label)
  VALUES (v_nate, 'ladder', 'STK-3', serial_key('STK-3'), 'FP900003');
  PERFORM pg_temp.want('a ladder does not take a fall-protection tag out of stock',
    (SELECT asset_id FROM fp_tag_stock WHERE tag_label = 'FP900003'), NULL::uuid);
END $$;

-- ── Visibility ──────────────────────────────────────────────────────────────
SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('a lead sees their own stock',
    (SELECT count(*)::int FROM fp_tag_stock WHERE source = 'test'), 3);
  PERFORM pg_temp.want_error('but cannot write it directly',
    $q$INSERT INTO fp_tag_stock (account_id, tag_label) VALUES (gen_random_uuid(), 'X')$q$);
END $$;
RESET ROLE;

SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael, a sibling
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('a sibling sees only their own',
    (SELECT count(*)::int FROM fp_tag_stock WHERE source = 'test'), 1);
END $$;
RESET ROLE;

-- 20_crew_removal_test leaves the office acting as Nate, and while it is the
-- office sees exactly what Nate sees. End that to look as the umbrella itself.
UPDATE impersonation_sessions SET ended_at = now() WHERE ended_at IS NULL;

SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- the umbrella
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('the umbrella sees everything beneath it',
    (SELECT count(*)::int FROM fp_tag_stock WHERE source = 'test'), 4);
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
BEGIN
  PERFORM pg_temp.want_error('the public cannot read stock at all',
    'SELECT count(*) FROM fp_tag_stock');
END $$;
RESET ROLE;

-- ── 29: an item matched by the tag's LINK learns the tag's label ───────────
DO $$
DECLARE v_nate uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
BEGIN
  INSERT INTO fp_tag_stock (account_id, tag_label, tag_url, source) VALUES
    (v_nate, 'FP900010', 'https://docs.google.com/spreadsheets/d/stockJ/edit?usp=drivesdk', 'test'),
    (v_nate, 'FP900011', 'https://docs.google.com/spreadsheets/d/stockK/edit?usp=drivesdk', 'test'),
    (v_nate, 'FP900012', 'https://docs.google.com/spreadsheets/d/stockL/edit?usp=drivesdk', 'test');

  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_url)
  VALUES (v_nate, 'fall_protection', 'STK-10', serial_key('STK-10'),
          'https://docs.google.com/spreadsheets/d/stockJ/edit?usp=drivesdk');
  PERFORM pg_temp.want('an item given a stocked tag''s link takes the printed label too',
    (SELECT tag_label FROM assets WHERE serial_raw = 'STK-10'), 'FP900010');
  PERFORM pg_temp.want('and the tag leaves stock',
    (SELECT a.serial_raw FROM fp_tag_stock s JOIN assets a ON a.id = s.asset_id
      WHERE s.tag_label = 'FP900010'), 'STK-10');

  -- A label already on the item is the tech's, and is not overwritten.
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_label, tag_url)
  VALUES (v_nate, 'fall_protection', 'STK-11', serial_key('STK-11'), 'OWN-LABEL',
          'https://docs.google.com/spreadsheets/d/stockK/edit?usp=drivesdk');
  PERFORM pg_temp.want('an item that already has a label keeps it',
    (SELECT tag_label FROM assets WHERE serial_raw = 'STK-11'), 'OWN-LABEL');

  -- Two items can never carry one label: the second is left without.
  UPDATE assets SET tag_label = 'FP900012' WHERE serial_raw = 'STK-1';
  INSERT INTO assets (account_id, kind, serial_raw, serial_key, tag_url)
  VALUES (v_nate, 'fall_protection', 'STK-12', serial_key('STK-12'),
          'https://docs.google.com/spreadsheets/d/stockL/edit?usp=drivesdk');
  PERFORM pg_temp.want('a label already on another item is not copied onto a second',
    (SELECT tag_label FROM assets WHERE serial_raw = 'STK-12'), NULL::text);
END $$;

-- Through the real write path: an inspection recorded with the tag's link.
SET lia.uid = '1a000000-0000-0000-0000-000000000002';
DO $$
DECLARE v_nate uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
BEGIN
  INSERT INTO fp_tag_stock (account_id, tag_label, tag_url, source)
  VALUES (v_nate, 'FP900020', 'https://docs.google.com/spreadsheets/d/stockW/edit?usp=drivesdk', 'test');
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'STK-20', 'equipment_type', 'climbing_belt',
    'tag_url', 'https://docs.google.com/spreadsheets/d/stockW/edit?usp=drivesdk',
    'checks', (SELECT jsonb_agg(jsonb_build_object('code', c.code, 'answer', c.pass_answer))
                 FROM fp_template_checks c
                 JOIN fp_check_templates t ON t.id = c.template_id
                 JOIN fp_equipment_types e ON e.id = t.equipment_type_id
                WHERE e.slug = 'climbing_belt' AND e.account_id IS NULL
                  AND t.published_at IS NOT NULL)));
  PERFORM pg_temp.want('recording an inspection with a stocked link takes the tag out of stock',
    (SELECT a.serial_raw FROM fp_tag_stock s JOIN assets a ON a.id = s.asset_id
      WHERE s.tag_label = 'FP900020'), 'STK-20');
  PERFORM pg_temp.want('and the certificate can be found by the printed number',
    (SELECT serial_num FROM fall_protection_public WHERE tag_label_key = 'FP900020'), 'STK-20');
END $$;

-- ── 29: what the phone pulls ────────────────────────────────────────────────
-- Nate's blank tags by now: FP900003 (only ever near a ladder) and this one.
INSERT INTO fp_tag_stock (account_id, tag_label, tag_url, source)
SELECT account_id, 'FP900030', 'https://docs.google.com/spreadsheets/d/stockZ/edit?usp=drivesdk', 'test'
  FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002';

SET lia.uid = '1a000000-0000-0000-0000-000000000002';   -- Nate
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('the phone gets the account''s blank tags',
    (SELECT count(*)::int FROM my_tag_stock() WHERE tag_label LIKE 'FP9%'), 2);
  PERFORM pg_temp.want('with each tag''s link',
    (SELECT tag_url FROM my_tag_stock() WHERE tag_label = 'FP900030'),
    'https://docs.google.com/spreadsheets/d/stockZ/edit?usp=drivesdk');
  PERFORM pg_temp.want('and never a tag already on an item',
    (SELECT count(*)::int FROM my_tag_stock() WHERE tag_label IN ('FP900001','FP900010','FP900011','FP900012','FP900020')), 0);
END $$;
RESET ROLE;

SET lia.uid = '1a000000-0000-0000-0000-000000000003';   -- Michael
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('a sibling''s phone gets only its own',
    (SELECT count(*)::int FROM my_tag_stock() WHERE tag_label LIKE 'FP9%'), 1);
END $$;
RESET ROLE;

SET lia.uid = '1a000000-0000-0000-0000-000000000001';   -- the umbrella
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.want('the umbrella''s phone does not claim its subcontractors'' tags',
    (SELECT count(*)::int FROM my_tag_stock() WHERE tag_label LIKE 'FP9%'), 0);
END $$;
RESET ROLE;

SET ROLE anon;
DO $$
BEGIN
  PERFORM pg_temp.want_error('the public cannot ask for stock', 'SELECT * FROM my_tag_stock()');
END $$;
RESET ROLE;
