-- Tag hyperlinks. Runs after 09_equipment_types_test.sql.
--
-- The properties that matter here:
--   • fp_tag_url_key agrees with urlKey() in field-app/js/tag-link.js, pair for
--     pair — a device and a server that disagree index items nobody can find
--   • a tag's link reaches the item, so the next tap resolves locally
--   • what a link CLAIMED can never become an inspection, a certificate, or a
--     satisfied due date, whoever is asking
--   • a sighting of an unknown tag does not conjure an asset

\set ON_ERROR_STOP on
\set ACME '11111111-1111-1111-1111-111111111111'
\set MALLORY '99999999-9999-9999-9999-999999999999'

\ir _helpers.sql
\ir ../12_tag_links.sql

SET lia.uid = '11111111-1111-1111-1111-111111111111';

-- ── The canonical key ───────────────────────────────────────────────────────
-- Every pair below is also asserted in field-app/test/tag-link.test.mjs against
-- the JavaScript. If you change one, change both.
DO $$ BEGIN
  PERFORM pg_temp.want('scheme and host fold to lower case',
    fp_tag_url_key('HTTPS://Docs.Google.COM/a/B'), 'https://docs.google.com/a/B');

  PERFORM pg_temp.want('but the path keeps its case, because ids are case-sensitive',
    fp_tag_url_key('https://x.com/AbC') <> fp_tag_url_key('https://x.com/abc'), true);

  PERFORM pg_temp.want('a leading www is dropped',
    fp_tag_url_key('https://www.acme.com/t/1'), 'https://acme.com/t/1');

  PERFORM pg_temp.want('a trailing slash is dropped',
    fp_tag_url_key('https://acme.com/t/1/'), 'https://acme.com/t/1');

  PERFORM pg_temp.want('the default port is dropped',
    fp_tag_url_key('https://acme.com:443/t'), 'https://acme.com/t');

  PERFORM pg_temp.want('a non-default port is kept',
    fp_tag_url_key('https://acme.com:8443/t'), 'https://acme.com:8443/t');

  PERFORM pg_temp.want('credentials in the authority are stripped',
    fp_tag_url_key('https://u:p@acme.com/t'), 'https://acme.com/t');

  -- Otherwise the same tag shared from two places indexes as two items.
  PERFORM pg_temp.want('tracking parameters are dropped',
    fp_tag_url_key('https://acme.com/t?id=7&utm_source=qr&gclid=z'), 'https://acme.com/t?id=7');

  PERFORM pg_temp.want('and the rest are sorted',
    fp_tag_url_key('https://acme.com/t?b=2&a=1'), 'https://acme.com/t?a=1&b=2');

  -- #gid is the only thing telling two tabs of one workbook apart.
  PERFORM pg_temp.want('a sheet tab id survives in the fragment',
    fp_tag_url_key('https://docs.google.com/spreadsheets/d/ID/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/ID/edit#gid=42');

  PERFORM pg_temp.want('any other fragment does not',
    fp_tag_url_key('https://acme.com/t#section'), 'https://acme.com/t');

  PERFORM pg_temp.want('an empty link keys to nothing rather than erroring',
    fp_tag_url_key(NULL), '');

  -- A tag can carry anything at all; the key must not throw on it.
  PERFORM pg_temp.want('a non-url is still keyed, consistently with itself',
    fp_tag_url_key('NOT A URL'), 'not a url');
END $$;

-- ── A link reaches the item ─────────────────────────────────────────────────
DO $$
DECLARE v_asset uuid; v_id uuid;
BEGIN
  PERFORM record_fp_inspection(jsonb_build_object(
    'serial_num',     'FP158354',
    'equipment_type', 'crane_lift_sling',
    'tag_url',        'https://docs.google.com/spreadsheets/d/SHEET1/htmlview',
    'checks',         (SELECT jsonb_agg(jsonb_build_object(
                                'code', code, 'prompt', prompt,
                                'answer', pass_answer))
                         FROM fp_current_checks(NULL, fp_type_for(NULL,'crane_lift_sling')))
  ));

  SELECT id INTO v_asset FROM assets
   WHERE kind = 'fall_protection' AND serial_key = serial_key('FP158354');

  PERFORM pg_temp.want('the inspection records the link that was read',
    (SELECT tag_url FROM fp_inspections WHERE asset_id = v_asset),
    'https://docs.google.com/spreadsheets/d/SHEET1/htmlview');

  -- This is what makes the next tap resolve without a fetch.
  PERFORM pg_temp.want('and the link reaches the item itself',
    (SELECT tag_url FROM assets WHERE id = v_asset),
    'https://docs.google.com/spreadsheets/d/SHEET1/htmlview');

  PERFORM pg_temp.want('keyed for lookup',
    (SELECT tag_url_key FROM assets WHERE id = v_asset),
    'https://docs.google.com/spreadsheets/d/SHEET1/htmlview');

  -- The device syncs from here; a column it is never sent cannot be indexed.
  PERFORM pg_temp.want('the device snapshot carries the link',
    (SELECT tag_url FROM account_snapshot(NULL) WHERE asset_id = v_asset),
    'https://docs.google.com/spreadsheets/d/SHEET1/htmlview');

  PERFORM pg_temp.want('and so does the public view',
    (SELECT tag_url FROM fall_protection_public WHERE serial_num = 'FP158354'),
    'https://docs.google.com/spreadsheets/d/SHEET1/htmlview');
END $$;

-- ── A sighting ──────────────────────────────────────────────────────────────
DO $$
DECLARE v_before int; v_id uuid;
BEGIN
  SELECT count(*)::int INTO v_before FROM assets;

  v_id := record_fp_tag_link(jsonb_build_object(
    'tag_url',    'https://docs.google.com/spreadsheets/d/UNKNOWN/htmlview',
    'nfc_tag_serial', '04A1B2C3'
  ));

  PERFORM pg_temp.want('an unknown tag is recorded',
    (SELECT count(*)::int FROM fp_tag_links WHERE id = v_id), 1);

  -- Walking past an item with a phone must not put it in the catalogue.
  PERFORM pg_temp.want('but conjures no asset',
    (SELECT count(*)::int FROM assets), v_before);

  PERFORM pg_temp.want('and stays unattached',
    (SELECT asset_id FROM fp_tag_links WHERE id = v_id), NULL::uuid);

  -- The same tag tapped again is one tag, not two.
  PERFORM record_fp_tag_link(jsonb_build_object(
    'tag_url', 'https://www.docs.google.com/spreadsheets/d/UNKNOWN/htmlview/'));

  PERFORM pg_temp.want('a second sighting of the same link does not duplicate it',
    (SELECT count(*)::int FROM fp_tag_links
      WHERE tag_url_key = fp_tag_url_key('https://docs.google.com/spreadsheets/d/UNKNOWN/htmlview')), 1);

  PERFORM pg_temp.want('it is counted',
    (SELECT seen_count FROM fp_tag_links WHERE id = v_id), 2);

  -- A later sighting that learned less must not erase what an earlier one knew.
  PERFORM pg_temp.want('and what the first sighting established is kept',
    (SELECT nfc_tag_uid FROM fp_tag_links WHERE id = v_id), '04A1B2C3');

  -- A sighting naming an item we do have ties itself to it.
  PERFORM record_fp_tag_link(jsonb_build_object(
    'tag_url',    'https://acme.example/tag/FP158354',
    'serial_num', 'FP158354'));

  PERFORM pg_temp.want('a sighting that names a known item is tied to it',
    (SELECT count(*)::int FROM fp_tag_links l JOIN assets a ON a.id = l.asset_id
      WHERE a.serial_key = serial_key('FP158354')), 1);
END $$;

-- ── What a link claimed is not an inspection ────────────────────────────────
DO $$
DECLARE v_asset uuid; v_id uuid; v_before int;
BEGIN
  SELECT id INTO v_asset FROM assets
   WHERE kind = 'fall_protection' AND serial_key = serial_key('FP158354');
  SELECT count(*)::int INTO v_before FROM fp_inspections WHERE asset_id = v_asset;

  v_id := record_fp_external(jsonb_build_object(
    'source_url', 'https://docs.google.com/spreadsheets/d/SHEET1/htmlview',
    'serial_num', 'FP158354',
    'fetched_at', now(),
    'claimed', jsonb_build_object(
      'serial', '', 'tag_id', 'FP158354',
      'inspection_date', '2026-08-22', 'overall_pass', true,
      'result_text', 'Pass', 'manufacturer', 'BUCKINGHAM', 'model', 'U69P98Q2')
  ));

  PERFORM pg_temp.want('the claim is filed', (SELECT count(*)::int FROM fp_external_records WHERE id = v_id), 1);
  PERFORM pg_temp.want('against the item it names',
    (SELECT asset_id FROM fp_external_records WHERE id = v_id), v_asset);

  -- The whole point of the separate table. If any of these ever fails, a forged
  -- tag can put a fabricated PASS into the safety history of a harness.
  PERFORM pg_temp.want('but it creates NO inspection',
    (SELECT count(*)::int FROM fp_inspections WHERE asset_id = v_asset), v_before);

  PERFORM pg_temp.want('and appears on no certificate',
    (SELECT count(*)::int FROM fall_protection_public
      WHERE serial_num = 'FP158354' AND inspection_date = '2026-08-22'
        AND version IS NULL), 0);

  PERFORM pg_temp.want('and cannot move a due date',
    (SELECT count(*)::int FROM fp_inspections i
      WHERE i.asset_id = v_asset AND i.next_due_date = date '2026-08-22' + interval '1 year'
        AND i.source = 'external'), 0);

  -- Re-tapping the same tag re-reads the same sheet.
  PERFORM record_fp_external(jsonb_build_object(
    'source_url', 'https://docs.google.com/spreadsheets/d/SHEET1/htmlview',
    'claimed', jsonb_build_object('inspection_date', '2026-08-22', 'overall_pass', true)));
  PERFORM pg_temp.want('the same claim twice is one row',
    (SELECT count(*)::int FROM fp_external_records
      WHERE source_url_key = fp_tag_url_key('https://docs.google.com/spreadsheets/d/SHEET1/htmlview')
        AND claimed_inspection_date = '2026-08-22'), 1);

  PERFORM pg_temp.want('provenance is mandatory',
    (SELECT count(*)::int FROM fp_external_records WHERE source_url IS NULL), 0);
END $$;

-- An external record with no source is a fabricated one; it must be impossible.
SELECT pg_temp.want_error('a claim with no source url is refused',
  $$ SELECT record_fp_external('{"claimed":{"overall_pass":true}}'::jsonb) $$);

SELECT pg_temp.want_error('a sighting with no link is refused',
  $$ SELECT record_fp_tag_link('{"serial_num":"FP158354"}'::jsonb) $$);

-- ── Neither table is writable by a client ───────────────────────────────────
-- Both go through SECURITY DEFINER functions, exactly as inspections do.
DO $$ BEGIN
  PERFORM pg_temp.want('authenticated cannot insert claims directly',
    has_table_privilege('authenticated', 'public.fp_external_records', 'INSERT'), false);
  PERFORM pg_temp.want('nor update them',
    has_table_privilege('authenticated', 'public.fp_external_records', 'UPDATE'), false);
  PERFORM pg_temp.want('nor insert tag sightings',
    has_table_privilege('authenticated', 'public.fp_tag_links', 'INSERT'), false);
  -- anon serves the public certificate site and has no business here at all.
  PERFORM pg_temp.want('anon cannot read claims',
    has_table_privilege('anon', 'public.fp_external_records', 'SELECT'), false);
  PERFORM pg_temp.want('nor tag sightings',
    has_table_privilege('anon', 'public.fp_tag_links', 'SELECT'), false);
END $$;
