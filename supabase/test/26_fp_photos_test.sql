-- Photos of failed fall-protection equipment (32).
-- Runs after 25_tag_stock_test.sql.
--
-- A photo is filed against the inspection it was taken for, found by serial and
-- capture time; only once the file is actually in the bucket; only in the
-- uploader's own account's folder. Reading follows the records: an umbrella
-- sees its subcontractors' photos, a sibling never does.

\set ON_ERROR_STOP on

\ir _helpers.sql
\ir ../migrations/32_fp_photos.sql

DO $$
DECLARE
  v_nate    uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002');
  v_michael uuid := (SELECT account_id FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003');
  v_asset   uuid;
  v_insp    uuid;
  v_path    text;
  v_id      uuid;
BEGIN
  PERFORM pg_temp.want('the bucket is private',
    (SELECT public FROM storage.buckets WHERE id = 'fp-photos'), false);
  PERFORM pg_temp.want('and takes only JPEGs up to 1 MB',
    (SELECT file_size_limit::int || ' ' || array_to_string(allowed_mime_types, ',')
       FROM storage.buckets WHERE id = 'fp-photos'), '1048576 image/jpeg');

  INSERT INTO assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_nate, 'fall_protection', 'PH-1', serial_key('PH-1')) RETURNING id INTO v_asset;
  INSERT INTO fp_inspections (account_id, asset_id, inspection_date, overall_pass, discard_reason, captured_at)
  VALUES (v_nate, v_asset, '2026-09-29', false, 'Failed: webbing cut', '2026-09-29T14:03:11.250Z')
  RETURNING id INTO v_insp;

  v_path := v_nate::text || '/11111111-2222-3333-4444-555555555555.jpg';
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate

  PERFORM pg_temp.want_error('a photo not yet in the bucket is not filed',
    format($q$SELECT record_fp_photo(jsonb_build_object('storage_path', %L,
      'serial_num', 'PH-1', 'captured_at', '2026-09-29T14:03:11.250Z'))$q$, v_path));

  INSERT INTO storage.objects (bucket_id, name) VALUES ('fp-photos', v_path);

  v_id := record_fp_photo(jsonb_build_object('storage_path', v_path, 'serial_num', 'ph 1',
    'captured_at', '2026-09-29T14:03:11.250Z', 'bytes', 142000, 'width', 1280, 'height', 960));
  PERFORM pg_temp.want('once uploaded it is filed against its inspection',
    (SELECT subject_id FROM inspection_photos WHERE id = v_id), v_insp);
  PERFORM pg_temp.want('in the uploader''s account, with its size',
    (SELECT account_id::text || ' ' || bytes FROM inspection_photos WHERE id = v_id), v_nate::text || ' 142000');
  PERFORM pg_temp.want('and a retention date',
    (SELECT expires_at IS NOT NULL FROM inspection_photos WHERE id = v_id), true);
  PERFORM pg_temp.want('a retry returns the same row rather than a second one',
    record_fp_photo(jsonb_build_object('storage_path', v_path, 'serial_num', 'PH-1',
      'captured_at', '2026-09-29T14:03:11.250Z')), v_id);
  PERFORM pg_temp.want('one row for the one file',
    (SELECT count(*)::int FROM inspection_photos WHERE storage_path = v_path), 1);

  PERFORM pg_temp.want_error('a photo for an inspection that has not landed is refused, to be retried',
    format($q$SELECT record_fp_photo(jsonb_build_object('storage_path', %L,
      'serial_num', 'PH-1', 'captured_at', '2026-09-29T15:00:00Z'))$q$, v_path));

  -- Michael cannot file into Nate's folder, even naming a real object.
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000003', true);
  PERFORM pg_temp.want_error('nobody files a photo into another account''s folder',
    format($q$SELECT record_fp_photo(jsonb_build_object('storage_path', %L,
      'serial_num', 'PH-1', 'captured_at', '2026-09-29T14:03:11.250Z'))$q$, v_path));
  PERFORM pg_temp.want_error('nor a path that is not an account folder at all',
    $q$SELECT record_fp_photo('{"storage_path":"../x.jpg","serial_num":"PH-1","captured_at":"2026-09-29T14:03:11.250Z"}')$q$);
END $$;

-- The storage policies, as the phone meets them. The account ids are looked up
-- before the role changes: as `authenticated`, account_members is behind RLS.
SELECT set_config('lia.test_nate',
         (SELECT account_id::text FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000002'), false),
       set_config('lia.test_michael',
         (SELECT account_id::text FROM account_members WHERE user_id = '1a000000-0000-0000-0000-000000000003'), false)
\gset
SET ROLE authenticated;
DO $$
DECLARE
  v_nate    uuid := current_setting('lia.test_nate')::uuid;
  v_michael uuid := current_setting('lia.test_michael')::uuid;
BEGIN
  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000002', true);   -- Nate
  PERFORM pg_temp.want('a tech reads his own account''s photos',
    (SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'fp-photos'), 1);
  INSERT INTO storage.objects (bucket_id, name) VALUES ('fp-photos', v_nate::text || '/own.jpg');
  PERFORM pg_temp.want('and writes into its folder', true, true);
  PERFORM pg_temp.want_error('but not into anybody else''s',
    format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('fp-photos', %L)$q$, v_michael::text || '/x.jpg'));

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000003', true);   -- Michael
  PERFORM pg_temp.want('a sibling subcontractor sees none of them',
    (SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'fp-photos'), 0);

  PERFORM set_config('lia.uid', '1a000000-0000-0000-0000-000000000001', true);   -- Batavia
  PERFORM pg_temp.want('the umbrella sees its subcontractor''s',
    (SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'fp-photos'), 2);
END $$;
RESET ROLE;
