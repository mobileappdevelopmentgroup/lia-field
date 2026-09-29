-- ═══════════════════════════════════════════════════════════════════
-- Lia Inspections v2 — safe to re-run; all statements are idempotent
--
-- Run AFTER 03_accounts_billing.sql.
--
-- Fixes three things that are survivable with one technician and disqualifying
-- with several:
--
--   1. UNIQUE (serial_num, inspection_date) made writes destructive. Two techs
--      inspecting the same serial on the same day silently overwrote each
--      other, and there was no record that it had happened.
--   2. RLS was USING (true) / WITH CHECK (true) for every authenticated user,
--      so any tech could read and overwrite any other company's inspections.
--   3. There was no stable public identifier — the public view omits id, so a
--      certificate could only be addressed by serial number.
--
-- The shape of the fix: an inspection is never updated in place. Re-recording
-- an inspection for the same item on the same date supersedes the previous row
-- and keeps it. "Different date" still means "a different inspection", so the
-- history the certificate site already shows is unchanged.
-- ═══════════════════════════════════════════════════════════════════

-- ── Serial normalization ──────────────────────────────────────────────────────
-- Two techs will type the same serial differently. Match on the normalized form,
-- keep the raw one for display.
CREATE OR REPLACE FUNCTION public.serial_key(p_serial text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(coalesce(p_serial, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- ── Short public identifier for certificate deep links ───────────────────────
-- Crockford-ish base32, no vowels, so it cannot spell anything and cannot be
-- confused between 0/O or 1/I when read off a printed certificate or an NFC tag.
CREATE OR REPLACE FUNCTION public.gen_public_ref()
RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := '0123456789BCDFGHJKLMNPQRSTVWXZ';
  out text := '';
BEGIN
  FOR i IN 1..10 LOOP
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN out;
END;
$$;

-- ── Assets: one row per physical item ────────────────────────────────────────
-- Shared by both scopes of work. Fall protection reuses this table rather than
-- getting its own — same identity, same account scoping, same public_ref.
CREATE TABLE IF NOT EXISTS public.assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'ladder' CHECK (kind IN ('ladder', 'fall_protection')),
  serial_raw  text NOT NULL,
  serial_key  text NOT NULL,
  public_ref  text NOT NULL DEFAULT public.gen_public_ref(),
  nfc_tag_uid text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_public_ref_uq') THEN
    ALTER TABLE public.assets ADD CONSTRAINT assets_public_ref_uq UNIQUE (public_ref);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_account_kind_serial_uq') THEN
    ALTER TABLE public.assets
      ADD CONSTRAINT assets_account_kind_serial_uq UNIQUE (account_id, kind, serial_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assets_serial_key_idx ON public.assets(serial_key);
CREATE INDEX IF NOT EXISTS assets_account_idx    ON public.assets(account_id);

-- ── Inspections gain identity, ownership and versioning ──────────────────────
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS account_id      uuid REFERENCES public.accounts(id);
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS asset_id        uuid REFERENCES public.assets(id);
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS work_order_uuid uuid REFERENCES public.work_orders(id);
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS tech_user_id    uuid REFERENCES auth.users(id);
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS version         integer NOT NULL DEFAULT 1;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS supersedes      uuid REFERENCES public.inspections(id);
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS is_current      boolean NOT NULL DEFAULT true;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS is_deleted      boolean NOT NULL DEFAULT false;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS source          text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS captured_at     timestamptz;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS lubricated      boolean;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS has_leveler     boolean;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS has_claw        boolean;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS has_vrung       boolean;

-- ── Backfill, in order. Every step is guarded so a re-run is a no-op. ─────────

-- 1. An asset per distinct serial. Ownership comes from usage_log where we can
--    establish it (that table is already user-scoped), otherwise from the only
--    account if there is exactly one.
DO $$
DECLARE v_solo uuid;
BEGIN
  SELECT id INTO v_solo FROM public.accounts LIMIT 1;
  IF (SELECT count(*) FROM public.accounts) <> 1 THEN v_solo := NULL; END IF;

  -- usage_log.work_order_id is free text, so two accounts may legitimately hold
  -- the same number. Only claim an inspection when the number maps to exactly
  -- one account; anything ambiguous is left for the fallback or for a human.
  UPDATE public.inspections i
     SET account_id = t.account_id
    FROM (
      SELECT u.work_order_id, min(m.account_id::text)::uuid AS account_id
        FROM public.usage_log u
        JOIN public.account_members m ON m.user_id = u.user_id
       GROUP BY u.work_order_id
      HAVING count(DISTINCT m.account_id) = 1
    ) t
   WHERE i.account_id IS NULL
     AND i.work_order_id IS NOT NULL
     AND i.work_order_id = t.work_order_id;

  -- A given physical ladder belongs to one customer, so an inspection whose own
  -- work order was ambiguous or unknown can inherit ownership from another
  -- inspection of the same serial that we did resolve.
  UPDATE public.inspections i
     SET account_id = t.account_id
    FROM (
      SELECT public.serial_key(serial_num) AS sk,
             min(account_id::text)::uuid   AS account_id
        FROM public.inspections
       WHERE account_id IS NOT NULL
       GROUP BY public.serial_key(serial_num)
      HAVING count(DISTINCT account_id) = 1
    ) t
   WHERE i.account_id IS NULL
     AND public.serial_key(i.serial_num) = t.sk;

  IF v_solo IS NOT NULL THEN
    UPDATE public.inspections SET account_id = v_solo WHERE account_id IS NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.inspections WHERE account_id IS NULL) THEN
    RAISE NOTICE 'inspections with no resolvable account: % — assign these by hand, they are invisible to the app until you do',
      (SELECT count(*) FROM public.inspections WHERE account_id IS NULL);
  END IF;
END $$;

-- 2. Create the assets those inspections point at.
INSERT INTO public.assets (account_id, kind, serial_raw, serial_key)
SELECT DISTINCT ON (i.account_id, public.serial_key(i.serial_num))
       i.account_id, 'ladder', i.serial_num, public.serial_key(i.serial_num)
  FROM public.inspections i
 WHERE i.asset_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.assets a
      WHERE a.account_id IS NOT DISTINCT FROM i.account_id
        AND a.kind = 'ladder'
        AND a.serial_key = public.serial_key(i.serial_num)
   )
 ORDER BY i.account_id, public.serial_key(i.serial_num), i.created_at;

-- 3. Point the inspections at them.
UPDATE public.inspections i
   SET asset_id = a.id
  FROM public.assets a
 WHERE i.asset_id IS NULL
   AND a.kind = 'ladder'
   AND a.serial_key = public.serial_key(i.serial_num)
   AND a.account_id IS NOT DISTINCT FROM i.account_id;

-- 4. Existing rows are all version 1 and current. The old unique constraint
--    guaranteed one row per (serial, date), so there is nothing to supersede.
UPDATE public.inspections SET captured_at = created_at WHERE captured_at IS NULL;
UPDATE public.inspections SET source = 'office' WHERE source IS NULL;

-- ── Only now is it safe to drop the destructive constraint ───────────────────
ALTER TABLE public.inspections DROP CONSTRAINT IF EXISTS inspections_serial_date_uq;

-- Replaces it. Same protection against duplicates, but a second write for the
-- same item and date supersedes the previous row instead of overwriting it.
CREATE UNIQUE INDEX IF NOT EXISTS inspections_current_uq
  ON public.inspections (asset_id, inspection_date)
  WHERE is_current AND NOT is_deleted;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspections_asset_version_uq') THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_asset_version_uq UNIQUE (asset_id, inspection_date, version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS inspections_account_idx ON public.inspections(account_id);
CREATE INDEX IF NOT EXISTS inspections_asset_idx   ON public.inspections(asset_id);

-- ── The single write path ────────────────────────────────────────────────────
-- Both autoInsertInspections and inspections:upload go through this. They used
-- to be two upserts against the same constraint that disagreed about nulls:
-- one sent notes: null and blanked out notes a tech had entered, the other
-- stripped nulls first.
CREATE OR REPLACE FUNCTION public.record_inspection(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_account  uuid;
  v_serial   text := trim(coalesce(p->>'serial_num', ''));
  v_date     date := coalesce((p->>'inspection_date')::date, current_date);
  v_asset    uuid;
  v_prev     public.inspections%ROWTYPE;
  v_id       uuid;
  v_version  integer := 1;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_serial = '' THEN RAISE EXCEPTION 'A serial number is required'; END IF;

  SELECT account_id INTO v_account FROM public.account_members WHERE user_id = v_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;

  INSERT INTO public.assets (account_id, kind, serial_raw, serial_key)
  VALUES (v_account, coalesce(p->>'kind', 'ladder'), v_serial, public.serial_key(v_serial))
  ON CONFLICT (account_id, kind, serial_key) DO NOTHING
  RETURNING id INTO v_asset;

  IF v_asset IS NULL THEN
    SELECT id INTO v_asset FROM public.assets
     WHERE account_id = v_account
       AND kind = coalesce(p->>'kind', 'ladder')
       AND serial_key = public.serial_key(v_serial);
  END IF;

  -- Supersede rather than overwrite.
  SELECT * INTO v_prev FROM public.inspections
   WHERE asset_id = v_asset AND inspection_date = v_date AND is_current AND NOT is_deleted
   FOR UPDATE;

  IF FOUND THEN
    v_version := v_prev.version + 1;
    UPDATE public.inspections SET is_current = false, updated_at = now() WHERE id = v_prev.id;
  END IF;

  INSERT INTO public.inspections (
    serial_num, inspection_date, tech_name, work_order_id, next_due_date, notes,
    brand, type, length, account_id, asset_id, tech_user_id,
    version, supersedes, is_current, source, captured_at,
    lubricated, has_leveler, has_claw, has_vrung
  ) VALUES (
    v_serial, v_date,
    coalesce(nullif(p->>'tech_name', ''), v_prev.tech_name, 'Lia Import'),
    coalesce(nullif(p->>'work_order_id', ''), v_prev.work_order_id),
    coalesce((p->>'next_due_date')::date, v_date + interval '1 year'),
    -- Carry a previous value forward when this write does not supply one, so a
    -- re-import can never blank out something a tech typed.
    coalesce(nullif(p->>'notes',  ''), v_prev.notes),
    coalesce(nullif(p->>'brand',  ''), v_prev.brand),
    coalesce(nullif(p->>'type',   ''), v_prev.type),
    coalesce(nullif(p->>'length', ''), v_prev.length),
    v_account, v_asset, v_user_id,
    v_version, v_prev.id, true,
    coalesce(p->>'source', 'office'),
    coalesce((p->>'captured_at')::timestamptz, now()),
    coalesce((p->>'lubricated')::boolean,  v_prev.lubricated),
    coalesce((p->>'has_leveler')::boolean, v_prev.has_leveler),
    coalesce((p->>'has_claw')::boolean,    v_prev.has_claw),
    coalesce((p->>'has_vrung')::boolean,   v_prev.has_vrung)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Batch wrapper — one round trip for a whole import.
CREATE OR REPLACE FUNCTION public.record_inspections(p jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE rec jsonb; n integer := 0;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(p) LOOP
    PERFORM public.record_inspection(rec);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.assets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "assets_select_own" ON public.assets;
CREATE POLICY "assets_select_own" ON public.assets
  FOR SELECT USING (account_id = public.my_account_id());

-- Replaces inspections_select_all / _insert_auth / _update_auth, which were all
-- USING (true) — every authenticated user could read and overwrite every
-- company's records.
DROP POLICY IF EXISTS "inspections_select_all"  ON public.inspections;
DROP POLICY IF EXISTS "inspections_insert_auth" ON public.inspections;
DROP POLICY IF EXISTS "inspections_update_auth" ON public.inspections;

DROP POLICY IF EXISTS "inspections_select_own" ON public.inspections;
CREATE POLICY "inspections_select_own" ON public.inspections
  FOR SELECT USING (account_id = public.my_account_id());

-- No INSERT or UPDATE policy. record_inspection() is the only write path, and
-- it is SECURITY DEFINER — so nothing can flip is_current or rewrite history
-- from a client.
REVOKE ALL ON public.inspections FROM anon;
REVOKE ALL ON public.assets      FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.inspections FROM authenticated;
GRANT SELECT ON public.inspections TO authenticated;
GRANT SELECT ON public.assets      TO authenticated;

-- ── Public view for the certificate site ─────────────────────────────────────
-- Columns are only ever ADDED here: inspection-site/index.html does select('*')
-- and reads fields by name, so adding is safe and renaming or removing is not.
DROP VIEW IF EXISTS public.ladder_inspections_public;
CREATE VIEW public.ladder_inspections_public AS
  SELECT
    -- The asset's canonical serial, not the raw text of whichever tech wrote
    -- last, so a certificate's serial does not change spelling between visits.
    coalesce(a.serial_raw, i.serial_num) AS serial_num,
    a.serial_key,          -- for lookups that should tolerate punctuation/case
    i.inspection_date,
    i.tech_name,
    i.next_due_date,
    i.work_order_id,
    i.notes,
    i.brand,
    i.type,
    i.length,
    i.created_at,
    a.public_ref,          -- stable handle for a certificate deep link
    i.version,
    i.lubricated,
    i.has_leveler,
    i.has_claw,
    i.has_vrung
  FROM public.inspections i
  LEFT JOIN public.assets a ON a.id = i.asset_id
  WHERE i.is_current AND NOT i.is_deleted
  ORDER BY i.serial_num, i.inspection_date DESC;

-- Must stay security_invoker = false (the default) — the view runs with its
-- owner's rights, which is what lets anon read through it with no base-table
-- grant. Setting security_invoker = true breaks the public site.
GRANT SELECT ON public.ladder_inspections_public TO anon;
GRANT SELECT ON public.ladder_inspections_public TO authenticated;
