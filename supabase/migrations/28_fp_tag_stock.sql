-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — tags a lead holds before they are put on anything.
-- Idempotent; safe to re-run. Run AFTER 27_shared_parts_catalog.sql.
--
-- Nate's tags arrive programmed: the label (FP161340) is printed on the face
-- and the chip already carries a link to that tag's own Google Sheet. Until one
-- is riveted to a harness it identifies nothing, so it cannot be an asset —
-- `assets` is keyed by the EQUIPMENT's serial, and a blank tag has no
-- equipment. But the company still needs to know which tags it holds, so that
-- a tag tapped in the field is recognised as ours and a lost reel can be
-- accounted for.
--
-- So a stocked tag carries the tag's two identifiers — label and link — and,
-- once it has been used, the asset it went on. Nothing else. It is NOT an
-- inspection and never appears on a certificate.
--
-- ASSIGNMENT IS DERIVED, NOT TYPED
--
-- A stocked tag becomes assigned when an asset in the same account is given
-- that label or that link, whichever path set it (an import, a tag write from
-- the phone, the tag-url trigger on an inspection). The trigger below does it,
-- so no write path has to remember to, and there are already four of those.
--
-- Uniqueness is NOT enforced by index, for the reason 17 gives for tag_label:
-- consolidate_to_one_account() merges companies, and two can legitimately hold
-- a tag with the same label. The load is idempotent instead.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fp_tag_stock (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Who physically has the reel. Null when the lead has not said.
  holder_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  tag_label      text NOT NULL,
  tag_label_key  text GENERATED ALWAYS AS (public.serial_key(tag_label)) STORED,
  tag_url        text,
  tag_url_key    text GENERATED ALWAYS AS (public.fp_tag_url_key(tag_url)) STORED,
  nfc_tag_uid    text,
  asset_id       uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  assigned_at    timestamptz,
  source         text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fp_tag_stock_label_idx
  ON public.fp_tag_stock (account_id, tag_label_key);
CREATE INDEX IF NOT EXISTS fp_tag_stock_url_idx
  ON public.fp_tag_stock (account_id, tag_url_key) WHERE tag_url_key <> '';
CREATE INDEX IF NOT EXISTS fp_tag_stock_asset_idx
  ON public.fp_tag_stock (asset_id);

ALTER TABLE public.fp_tag_stock ENABLE ROW LEVEL SECURITY;

-- Work flows up: the umbrella sees its subcontractors' stock; siblings do not
-- see each other's.
DROP POLICY IF EXISTS fp_tag_stock_read ON public.fp_tag_stock;
CREATE POLICY fp_tag_stock_read ON public.fp_tag_stock
  FOR SELECT TO authenticated USING (public.can_see(account_id));

REVOKE ALL ON public.fp_tag_stock FROM anon, authenticated;
GRANT SELECT ON public.fp_tag_stock TO authenticated;

-- ── A tag put on an item leaves stock ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fp_tag_stock_assign() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.kind <> 'fall_protection' THEN RETURN NEW; END IF;

  UPDATE public.fp_tag_stock s
     SET asset_id = NEW.id, assigned_at = coalesce(s.assigned_at, now())
   WHERE s.account_id = NEW.account_id
     AND s.asset_id IS DISTINCT FROM NEW.id
     AND ((coalesce(NEW.tag_label_key, '') <> '' AND s.tag_label_key = NEW.tag_label_key)
       OR (coalesce(NEW.tag_url_key,   '') <> '' AND s.tag_url_key   = NEW.tag_url_key));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fp_tag_stock_assign_t ON public.assets;
CREATE TRIGGER fp_tag_stock_assign_t
  AFTER INSERT OR UPDATE OF tag_label, tag_url ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.fp_tag_stock_assign();
