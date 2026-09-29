-- 32 — Photos of failed fall-protection equipment, uploaded.
--
-- A photo has been REQUIRED to remove an item from service since 06, and
-- inspection_photos has been its index since then too — but nothing ever put a
-- file anywhere. The photos sat on the phone, in the same 5 MB of localStorage
-- as the day's jobs, and the manual told the tech they uploaded.
--
-- This is the server half:
--
--   · a PRIVATE bucket, fp-photos. The photo is evidence about a customer's
--     equipment, not something a certificate link should hand to anybody.
--   · a path convention, <account id>/<photo id>.jpg. The first folder is what
--     the storage policies check, so a tech can only write into his own
--     company's folder and only read the folders he could read the records of.
--   · record_fp_photo(), which files an uploaded object against its inspection.
--
-- The phone uploads the file first and indexes it second. The index insists the
-- object exists, so a row can never point at a file that is not there; the other
-- order — a file with no row — is harmless, and a retry fills it in.
--
-- The inspection is found by what the phone already knows about it: the serial
-- and the moment it was captured. fp_inspections has no client id, and the
-- captured_at the phone sent is stored verbatim, so the pair is exact. A
-- correction in the office supersedes the row; the photo stays on the version
-- the tech recorded, which is the one he photographed.
--
-- Size: the phone compresses to a ~1280 px JPEG at roughly 100–200 KB before
-- this ever sees it. The bucket refuses anything over 1 MB or not a JPEG, so a
-- client that skipped compression is refused rather than billed.
--
-- Safe to re-run.

-- ── The bucket ───────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('fp-photos', 'fp-photos', false, 1048576, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- The account a storage path belongs to, or NULL if its first folder is not an
-- account id. A cast of arbitrary text to uuid raises, and a policy that raises
-- turns "you may not read this" into an error on every listing.
CREATE OR REPLACE FUNCTION public.photo_path_account(p_path text)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN split_part(p_path, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN split_part(p_path, '/', 1)::uuid
  END;
$$;

-- ── Who may touch the files ──────────────────────────────────────────────────
-- Write: into your own account's folder only. Read: any folder whose records
-- you can already see (an umbrella sees its subcontractors', never sideways).
-- No UPDATE or DELETE policy at all: evidence is not edited from a phone, and
-- retention deletes with the service role.
DROP POLICY IF EXISTS fp_photos_insert ON storage.objects;
CREATE POLICY fp_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'fp-photos'
              AND public.photo_path_account(name) = public.my_account_id());

DROP POLICY IF EXISTS fp_photos_select ON storage.objects;
CREATE POLICY fp_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'fp-photos'
         AND public.can_see(public.photo_path_account(name)));

-- ── Filing an uploaded photo against its inspection ──────────────────────────
-- Idempotent on the path: a retry after a dropped response returns the row the
-- first attempt made.
CREATE OR REPLACE FUNCTION public.record_fp_photo(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_account uuid;
  v_path    text := nullif(btrim(coalesce(p->>'storage_path', '')), '');
  v_serial  text := nullif(btrim(coalesce(p->>'serial_num', '')), '');
  v_at      timestamptz;
  v_insp    uuid;
  v_id      uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_account := public.my_account_id();
  IF v_account IS NULL THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  IF v_path IS NULL THEN RAISE EXCEPTION 'A storage path is required'; END IF;
  IF public.photo_path_account(v_path) IS DISTINCT FROM v_account OR v_path LIKE '%..%' THEN
    RAISE EXCEPTION 'That photo is not in your account''s folder';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o
                  WHERE o.bucket_id = 'fp-photos' AND o.name = v_path) THEN
    RAISE EXCEPTION 'That photo has not been uploaded';
  END IF;

  IF v_serial IS NULL THEN RAISE EXCEPTION 'A serial number is required'; END IF;
  v_at := nullif(p->>'captured_at', '')::timestamptz;
  IF v_at IS NULL THEN RAISE EXCEPTION 'The inspection''s capture time is required'; END IF;

  SELECT i.id INTO v_insp
    FROM public.fp_inspections i
    JOIN public.assets a ON a.id = i.asset_id
   WHERE i.account_id = v_account
     AND i.captured_at = v_at
     AND a.serial_key = public.serial_key(v_serial)
     AND NOT i.is_deleted
   ORDER BY i.is_current DESC, i.created_at DESC
   LIMIT 1;
  -- The phone queues the photo behind its inspection, so this means the
  -- inspection has not landed yet. The queue retries; the photo is not lost.
  IF v_insp IS NULL THEN RAISE EXCEPTION 'Its inspection has not been uploaded yet'; END IF;

  INSERT INTO public.inspection_photos
    (account_id, subject_kind, subject_id, storage_path, bytes, width, height,
     captured_at, uploaded_by)
  VALUES
    (v_account, 'fp_inspection', v_insp, v_path,
     nullif(p->>'bytes', '')::integer, nullif(p->>'width', '')::integer,
     nullif(p->>'height', '')::integer,
     coalesce(nullif(p->>'photo_captured_at', '')::timestamptz, v_at), v_user)
  ON CONFLICT (storage_path) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.inspection_photos
     WHERE storage_path = v_path AND account_id = v_account;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_fp_photo(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_fp_photo(jsonb) TO authenticated;
