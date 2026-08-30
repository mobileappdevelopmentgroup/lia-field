-- Writing tags, and finding an item however you are holding it.
-- Runs after 14_assignments_test.sql.
--
-- The properties that matter:
--   • all five identifiers reach the SAME item — serial, tag label, chip id,
--     certificate code, and the link
--   • the URL written carries the serial AND the certificate code, so
--     correcting a serial does not orphan tags already in the field
--   • a tag label cannot be taken from another item
--   • the URL is decided server-side, so a client cannot make the record claim
--     we wrote a link to somewhere else
--   • a queued write that retries records one write, not five

\set ON_ERROR_STOP on
\set ALEX '11111111-1111-1111-1111-111111111111'
\set SUB  '33333333-3333-3333-3333-333333333333'

\ir _helpers.sql
\ir ../17_tag_write.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- Two items, inspected the ordinary way.
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'TW-1', 'equipment_type', 'body_harness',
    'manufacturer', 'MSA', 'model', 'V-FIT',
    'inspection_date', '2026-08-20', 'work_order_id', 'WO-TW', 'checks', v_checks));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'TW-2', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-20', 'work_order_id', 'WO-TW', 'checks', v_checks));
END $$;

-- ── What should go on the tag ───────────────────────────────────────────────
DO $$
DECLARE v json; v_ref text;
BEGIN
  v_ref := (SELECT public_ref FROM assets WHERE serial_raw = 'TW-1');

  v := fp_tag_write_plan('{"serial_num":"TW-1","tag_label":"FP158354"}'::jsonb);
  PERFORM pg_temp.want('the plan finds the item by serial', v->>'serial_num', 'TW-1');
  -- THE property of the URL. Both identifiers, for the reason in the migration
  -- header: the serial makes it legible, the ref makes it survive a correction.
  PERFORM pg_temp.want('the URL carries the certificate code',
    (v->>'url') LIKE '%?t=' || v_ref || '%', true);
  PERFORM pg_temp.want('and the serial as well',
    (v->>'url') LIKE '%&s=TW-1', true);
  PERFORM pg_temp.want('and it points at our certificate site',
    (v->>'url') LIKE 'https://lia.mobileappdevelopmentgroup.com/fp/%', true);
  PERFORM pg_temp.want('the label the tech is about to print is echoed back',
    v->>'tag_label', 'FP158354');

  -- Nothing has been written yet; a plan must not touch the item.
  PERFORM pg_temp.want('planning writes nothing',
    (SELECT tag_label FROM assets WHERE serial_raw = 'TW-1'), NULL);
END $$;

-- A serial with characters that would break a query string.
DO $$
DECLARE v_checks jsonb; v json;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'A/B#1 C', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-20', 'checks', v_checks));
  v := fp_tag_write_plan('{"serial_num":"A/B#1 C"}'::jsonb);
  -- A '#' in a serial would truncate the whole query string at the fragment.
  PERFORM pg_temp.want('a serial with slashes, hashes and spaces is encoded',
    (v->>'url') LIKE '%&s=A%2FB%231%20C', true);
END $$;

-- ── Recording the write ─────────────────────────────────────────────────────
DO $$
DECLARE v json;
BEGIN
  v := record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0001', 'serial_num', 'TW-1',
    'tag_label', 'FP158354', 'nfc_tag_uid', '04:11:22:33'));
  PERFORM pg_temp.want('the write is recorded', v->>'tag_label', 'FP158354');
  PERFORM pg_temp.want('and the item learned its label',
    (SELECT tag_label FROM assets WHERE serial_raw = 'TW-1'), 'FP158354');
  PERFORM pg_temp.want('and its chip id',
    (SELECT nfc_tag_uid FROM assets WHERE serial_raw = 'TW-1'), '04:11:22:33');
  PERFORM pg_temp.want('and its link',
    (SELECT tag_url FROM assets WHERE serial_raw = 'TW-1') LIKE '%&s=TW-1', true);
END $$;

-- The upload queue retries. A tag written once must not appear as five writes.
DO $$ BEGIN
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0001', 'serial_num', 'TW-1',
    'tag_label', 'FP158354', 'nfc_tag_uid', '04:11:22:33'));
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0001', 'serial_num', 'TW-1',
    'tag_label', 'FP158354', 'nfc_tag_uid', '04:11:22:33'));
  PERFORM pg_temp.want('a retried write is one write',
    (SELECT count(*)::int FROM fp_tag_writes WHERE client_id = 'w-0001'), 1);
END $$;

-- A client cannot make the record claim we wrote a link to somewhere else.
DO $$
DECLARE v json;
BEGIN
  v := record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0002', 'serial_num', 'TW-2',
    'tag_url', 'https://evil.example/steal', 'tag_label', 'FP900001'));
  PERFORM pg_temp.want('the URL is rebuilt server-side, not taken from the payload',
    (v->>'tag_url') LIKE 'https://lia.mobileappdevelopmentgroup.com/fp/%', true);
  PERFORM pg_temp.want('and the supplied one is nowhere on the item',
    (SELECT tag_url FROM assets WHERE serial_raw = 'TW-2') LIKE '%evil%', false);
END $$;

-- ── A label belongs to one item ─────────────────────────────────────────────
DO $$ BEGIN
  -- Moving it would leave TW-1 unfindable by the label printed on its own tag.
  PERFORM pg_temp.want_error('a label already on another item is refused',
    $q$ SELECT record_fp_tag_write('{"client_id":"w-0003","serial_num":"TW-2","tag_label":"FP158354"}'::jsonb) $q$);
  PERFORM pg_temp.want('and the first item kept it',
    (SELECT tag_label FROM assets WHERE serial_raw = 'TW-1'), 'FP158354');
  -- Told BEFORE the phone is held against a tag, not after a half-done write.
  PERFORM pg_temp.want_error('and the plan refuses it up front too',
    $q$ SELECT fp_tag_write_plan('{"serial_num":"TW-2","tag_label":"FP158354"}'::jsonb) $q$);
END $$;

-- Re-writing the SAME item's label is not a clash.
DO $$ BEGIN
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0004', 'serial_num', 'TW-1', 'tag_label', 'FP158354'));
  PERFORM pg_temp.want('re-tagging the same item is allowed',
    (SELECT tag_label FROM assets WHERE serial_raw = 'TW-1'), 'FP158354');
END $$;

-- A write that knew less must not erase what an earlier one established.
DO $$ BEGIN
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0005', 'serial_num', 'TW-1'));
  PERFORM pg_temp.want('a write with no chip id does not wipe the one on record',
    (SELECT nfc_tag_uid FROM assets WHERE serial_raw = 'TW-1'), '04:11:22:33');
  PERFORM pg_temp.want('nor the label',
    (SELECT tag_label FROM assets WHERE serial_raw = 'TW-1'), 'FP158354');
END $$;

-- A hardware uid is physically unique: two tags cannot share one. A uid that
-- turns up on a second item means somebody tagged the wrong thing, and letting
-- it through would make both resolve arbitrarily on a tap.
DO $$ BEGIN
  PERFORM pg_temp.want_error('a chip id already on another item is refused',
    $q$ SELECT record_fp_tag_write('{"client_id":"w-0007","serial_num":"TW-2","nfc_tag_uid":"04:11:22:33"}'::jsonb) $q$);
  PERFORM pg_temp.want('and the first item kept its chip',
    (SELECT nfc_tag_uid FROM assets WHERE serial_raw = 'TW-1'), '04:11:22:33');
END $$;

-- Re-tagging is visible as a re-tag.
DO $$ BEGIN
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id', 'w-0006', 'serial_num', 'TW-1',
    'tag_label', 'FP999999', 'nfc_tag_uid', '04:FF:EE:DD'));
  PERFORM pg_temp.want('the new label is on the item',
    (SELECT tag_label FROM assets WHERE serial_raw = 'TW-1'), 'FP999999');
  PERFORM pg_temp.want('and what it replaced is on record',
    (SELECT prev_label FROM fp_tag_writes WHERE client_id = 'w-0006'), 'FP158354');
END $$;

-- ── Five ways in, one item ──────────────────────────────────────────────────
-- The whole point of the feature: a tech finds the record with whatever he has.
DO $$
DECLARE v_asset uuid; v_ref text; v_url text;
BEGIN
  SELECT id, public_ref, tag_url INTO v_asset, v_ref, v_url
    FROM assets WHERE serial_raw = 'TW-1';

  PERFORM pg_temp.want('the serial finds it',
    (fp_find_asset('TW-1')->'asset'->>'id')::uuid, v_asset);
  PERFORM pg_temp.want('the label printed on the tag finds it',
    (fp_find_asset('FP999999')->'asset'->>'id')::uuid, v_asset);
  -- Read off the chip on a tap, in whatever punctuation the hardware gives it.
  PERFORM pg_temp.want('the chip id finds it, however it is punctuated',
    (fp_find_asset('04-ff-ee-dd')->'asset'->>'id')::uuid, v_asset);
  PERFORM pg_temp.want('and so does the unpunctuated form',
    (fp_find_asset('04FFEEDD')->'asset'->>'id')::uuid, v_asset);
  -- The chip this item used to carry now belongs to nothing of ours.
  PERFORM pg_temp.want('the chip it was re-tagged away from no longer points here',
    (fp_find_asset('04112233')->'asset'->>'id')::uuid, NULL);
  PERFORM pg_temp.want('the certificate code finds it',
    (fp_find_asset(v_ref)->'asset'->>'id')::uuid, v_asset);
  PERFORM pg_temp.want('and following the link finds it',
    (fp_find_asset(v_url)->'asset'->>'id')::uuid, v_asset);

  -- Each says HOW it matched, so the app can decide what is safe to pre-fill.
  PERFORM pg_temp.want('and each says which identifier it was',
    fp_find_asset('FP999999')->>'by', 'tag_label');

  -- A link we have never seen still resolves, by what is inside it.
  PERFORM pg_temp.want('a certificate link not yet on the item still resolves',
    (fp_find_asset('https://lia.mobileappdevelopmentgroup.com/fp/?t=' || v_ref)->'asset'->>'id')::uuid,
    v_asset);
  -- Including one that carries only the serial.
  PERFORM pg_temp.want('and so does one carrying only the serial',
    (fp_find_asset('https://lia.mobileappdevelopmentgroup.com/fp/?s=TW-1')->'asset'->>'id')::uuid,
    v_asset);

  PERFORM pg_temp.want('and nothing matches nothing',
    fp_find_asset('NOPE-404') IS NULL, true);
END $$;

-- ── Correcting a serial does not orphan the tag ─────────────────────────────
-- The reason the URL carries the certificate code as well. A tag riveted to a
-- harness cannot be rewritten because somebody fixed a typo in the office.
DO $$
DECLARE v_old_url text; v_asset uuid;
BEGIN
  SELECT id, tag_url INTO v_asset, v_old_url FROM assets WHERE serial_raw = 'TW-1';
  PERFORM update_fp_asset(jsonb_build_object(
    'asset_id', v_asset, 'serial_raw', 'TW-1-CORRECTED',
    'reason', 'Serial was mistyped on first entry'));

  PERFORM pg_temp.want('the serial changed',
    (SELECT serial_raw FROM assets WHERE id = v_asset), 'TW-1-CORRECTED');
  -- THE property. The link already in the field still lands on the right item.
  PERFORM pg_temp.want('and the tag already in the field still resolves',
    (fp_find_asset(v_old_url)->'asset'->>'id')::uuid, v_asset);
END $$;

-- ── The public certificate site ─────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('the public view carries the label, so a visitor can be found by it',
    (SELECT count(*)::int FROM fall_protection_public WHERE tag_label = 'FP999999'), 1);
  PERFORM pg_temp.want('and the URL a tag should carry',
    (SELECT tag_write_url FROM fall_protection_public WHERE tag_label = 'FP999999') LIKE '%?t=%&s=%', true);
END $$;

-- ── The phone gets the label too ────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('the device snapshot carries the label',
    (SELECT tag_label FROM account_snapshot(NULL, 2000, NULL, NULL)
      WHERE serial_raw = 'TW-1-CORRECTED'), 'FP999999');
  PERFORM pg_temp.want('and its normalized key, so an offline lookup can match it',
    (SELECT tag_label_key FROM account_snapshot(NULL, 2000, NULL, NULL)
      WHERE serial_raw = 'TW-1-CORRECTED'), 'FP999999');
END $$;

-- ── The office ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.want('the office can search by the label somebody reads down the phone',
    (SELECT count(*)::int FROM json_array_elements(fp_records('FP999999', NULL, 100, 0)->'rows')), 1);
  PERFORM pg_temp.want('and the label is on the row it returns',
    (SELECT r->>'tag_label' FROM json_array_elements(fp_records('FP999999', NULL, 100, 0)->'rows') r), 'FP999999');
  PERFORM pg_temp.want('searching by serial still works',
    (SELECT count(*)::int FROM json_array_elements(fp_records('TW-1-CORRECTED', NULL, 100, 0)->'rows')), 1);
END $$;

-- ── The office correcting a label ───────────────────────────────────────────
-- A label typed wrong on the phone is the ordinary case, and it has to be
-- fixable without re-writing a tag that is already on the equipment.
DO $$
DECLARE v_asset uuid := (SELECT id FROM assets WHERE serial_raw = 'TW-1-CORRECTED');
BEGIN
  PERFORM pg_temp.want_error('correcting a label still needs a reason',
    format($q$ SELECT update_fp_asset(jsonb_build_object('asset_id', %L, 'tag_label', 'FP111111')) $q$, v_asset));

  PERFORM update_fp_asset(jsonb_build_object(
    'asset_id', v_asset, 'tag_label', 'FP111111',
    'reason', 'Label was read off the wrong tag'));
  PERFORM pg_temp.want('with one, the label is corrected',
    (SELECT tag_label FROM assets WHERE id = v_asset), 'FP111111');
  PERFORM pg_temp.want('and the corrected label finds it',
    (fp_find_asset('FP111111')->'asset'->>'id')::uuid, v_asset);
  -- The audit trail is the point of going through this function at all.
  PERFORM pg_temp.want('and the change is on the audit trail',
    (SELECT count(*)::int FROM fp_record_audit
      WHERE asset_id = v_asset AND reason = 'Label was read off the wrong tag'), 1);

  -- TW-2 holds FP900001 from the write above.
  PERFORM pg_temp.want_error('the office cannot take a label off another item either',
    format($q$ SELECT update_fp_asset(jsonb_build_object(
      'asset_id', %L, 'tag_label', 'FP900001', 'reason', 'x')) $q$, v_asset));
END $$;

-- ── The account boundary ────────────────────────────────────────────────────
SET lia.uid = '99999999-9999-9999-9999-999999999999';
DO $$ BEGIN
  PERFORM pg_temp.want('another company cannot find this item by any identifier',
    fp_find_asset('FP999999') IS NULL, true);
  PERFORM pg_temp.want_error('nor write to it',
    $q$ SELECT record_fp_tag_write('{"serial_num":"TW-1-CORRECTED","tag_label":"X"}'::jsonb) $q$);
END $$;

-- And a label used by one company must not block another from using it.
DO $$
DECLARE v_checks jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('code', code, 'prompt', prompt, 'answer', pass_answer))
    INTO v_checks FROM fp_current_checks(NULL, fp_type_for(NULL, 'body_harness'));
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num', 'RIVAL-1', 'equipment_type', 'body_harness',
    'inspection_date', '2026-08-20', 'checks', v_checks));
  PERFORM record_fp_tag_write(jsonb_build_object(
    'client_id', 'r-1', 'serial_num', 'RIVAL-1', 'tag_label', 'FP999999'));
  PERFORM pg_temp.want('the same label in a different company is fine',
    (SELECT tag_label FROM assets WHERE serial_raw = 'RIVAL-1'), 'FP999999');
END $$;
