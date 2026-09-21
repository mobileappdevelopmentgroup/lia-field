-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — the lead's own parts catalogue, shared to their techs.
-- Idempotent; safe to re-run. Run AFTER 26_field_work.sql.
--
-- The field app ships with a seed list and, since the BSI pull, all 1,936 part
-- numbers BSI knows. Neither is *this company's* list. A lead knows which forty
-- parts their crew actually reaches for, which ones come in twos, and what to
-- call them; and the only way to get that onto a phone was to tell somebody to
-- type it in.
--
-- WHAT THIS IS NOT
--
-- It is not a replacement for the tech's library. What a tech favourites, the
-- order they put their favourites in, the quantity they set and any part they
-- added themselves are THEIRS and live on the device. A lead publishing a
-- catalogue must never rearrange the buttons under somebody's thumb mid-job.
-- So this is a baseline: it arrives behind what the tech already has, exactly
-- as the BSI catalogue does (see mergeCatalogIntoLibrary in catalog.js).
--
-- DIRECTION
--
-- The catalogue flows DOWN, like every other catalogue in this schema
-- (18_umbrella_accounts.sql): parts defined by Batavia are usable by everyone
-- beneath it, and a subcontractor's own additions are theirs alone. Work flows
-- up; catalogues flow down. Reversing either leaks one company into another.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.account_parts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  part_number  text NOT NULL,
  -- Normalised for identity. Techs type "lgh123wp", BSI writes "LGH123WP",
  -- and the lead may have typed it either way on a different day.
  part_key     text GENERATED ALWAYS AS (upper(btrim(part_number))) STORED,
  description  text,
  -- What the lead suggests, not what the tech is stuck with.
  favorited    boolean NOT NULL DEFAULT false,
  default_qty  integer NOT NULL DEFAULT 1 CHECK (default_qty >= 1),
  ord          integer,
  is_deleted   boolean NOT NULL DEFAULT false,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One entry per part per account. Deleting is soft, so the unique index has to
-- cover deleted rows too or a re-add collides with the tombstone.
CREATE UNIQUE INDEX IF NOT EXISTS account_parts_uq
  ON public.account_parts (account_id, part_key);

ALTER TABLE public.account_parts ENABLE ROW LEVEL SECURITY;

-- Read follows can_use_catalog: an account sees its own and its umbrella's.
DROP POLICY IF EXISTS account_parts_read ON public.account_parts;
CREATE POLICY account_parts_read ON public.account_parts
  FOR SELECT TO authenticated USING (public.can_use_catalog(account_id));

-- Written only through the function below, as every catalogue in this schema is.
REVOKE INSERT, UPDATE, DELETE ON public.account_parts FROM authenticated;
GRANT  SELECT ON public.account_parts TO authenticated;

-- ── Authoring ───────────────────────────────────────────────────────────────
-- Takes the whole list the office is showing and makes the account match it.
-- Parts that disappear from the payload are soft-deleted rather than dropped,
-- so a phone that has not synced since can still be told they went.
--
-- Uses require_lead_account() (26), so it follows an impersonation session —
-- the office editing a subcontractor's catalogue while acting as them writes
-- to THEIR account. That was the gap 21 left open for catalogue authoring, and
-- a new catalogue should not be built with it still open.
CREATE OR REPLACE FUNCTION public.save_account_parts(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_items   jsonb := coalesce(p->'parts', '[]'::jsonb);
  v_seen    text[] := '{}';
  v_n       integer := 0;
  e         jsonb;
BEGIN
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'parts must be a list';
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    CONTINUE WHEN nullif(btrim(coalesce(e->>'part_number','')), '') IS NULL;

    INSERT INTO public.account_parts
      (account_id, part_number, description, favorited, default_qty, ord, created_by)
    VALUES (
      v_account,
      btrim(e->>'part_number'),
      nullif(btrim(coalesce(e->>'description','')), ''),
      coalesce((e->>'favorited')::boolean, false),
      greatest(1, coalesce((e->>'default_qty')::integer, 1)),
      (e->>'ord')::integer,
      auth.uid())
    ON CONFLICT (account_id, part_key) DO UPDATE
      SET part_number = excluded.part_number,
          description = coalesce(excluded.description, public.account_parts.description),
          favorited   = excluded.favorited,
          default_qty = excluded.default_qty,
          ord         = excluded.ord,
          is_deleted  = false,
          updated_at  = now();

    v_seen := v_seen || upper(btrim(e->>'part_number'));
    v_n := v_n + 1;
  END LOOP;

  -- Anything the lead removed. Tombstoned, not deleted: a phone that has been
  -- in a basement for a week needs to be told a part went, and a row that
  -- simply vanished tells it nothing.
  UPDATE public.account_parts
     SET is_deleted = true, updated_at = now()
   WHERE account_id = v_account AND NOT is_deleted AND NOT (part_key = ANY (v_seen));

  RETURN json_build_object('saved', v_n,
    'removed', (SELECT count(*) FROM public.account_parts
                 WHERE account_id = v_account AND is_deleted));
END;
$$;
REVOKE ALL ON FUNCTION public.save_account_parts(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.save_account_parts(jsonb) TO authenticated;

-- ── What a phone pulls ──────────────────────────────────────────────────────
-- Everything the caller's account may use, its own and its umbrella's, with
-- the account's own entry winning where both define the same part. Tombstones
-- come too: `is_deleted` is how a device learns something went away.
--
-- `p_since` makes this incremental, like account_snapshot. A device that has
-- the list already asks only for what changed.
CREATE OR REPLACE FUNCTION public.account_parts_catalog(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (
  part_number text, description text, favorited boolean,
  default_qty integer, ord integer, is_deleted boolean, updated_at timestamptz
)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT DISTINCT ON (a.part_key)
         a.part_number, a.description, a.favorited,
         a.default_qty, a.ord, a.is_deleted, a.updated_at
    FROM public.account_parts a
   WHERE public.can_use_catalog(a.account_id)
     AND (p_since IS NULL OR a.updated_at > p_since)
   -- The account's own row beats one inherited from the umbrella: a
   -- subcontractor who has set a quantity for a part means it.
   ORDER BY a.part_key, (a.account_id = v_account) DESC, a.updated_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.account_parts_catalog(timestamptz) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.account_parts_catalog(timestamptz) TO authenticated;
