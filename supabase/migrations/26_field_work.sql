-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — Field Work: what has gone to BSI, what has been corrected, what is
-- finished with. Idempotent; safe to re-run.
--
-- Run AFTER 25_assigned_by.sql.
--
-- WHAT THIS IS FOR
--
-- The office screen becomes one list of work orders that carry field records,
-- and each one is in exactly one of four states:
--
--   needs processing   no record has been pushed to BSI
--   processed          every current record has been pushed        (green)
--   has edits          some have not, or a correction supersedes a
--                      record that had been pushed                 (orange)
--   archived           the lead has been paid/approved and filed it away,
--                      so it leaves Field Work for Work History
--
-- Three of those are DERIVED from the records, not stored. Storing "processed"
-- as a flag on the work order is the bug this is written to avoid: a tech adds
-- three ladders to a work order that was imported yesterday, the flag still
-- says processed, and those three are never billed. Deriving it means the
-- work order goes orange by itself the moment anything beneath it changes.
--
-- WHAT WAS MISSING BEFORE THIS
--
--   * `inspections` had no `bsi_pushed_at`. Only `fp_inspections` did, so for
--     half the data there was no fact in the database saying whether it had
--     reached BSI at all. `usage_log` is not a substitute: it records a credit
--     consumed per WORK ORDER, which cannot tell you that three of its forty
--     ladders arrived afterwards and never went in.
--   * Ladders had no correction path. FP has amend/delete/restore with a typed
--     reason and an audit row; ladders had nothing, so "the lead should be able
--     to correct every record" was true for half of them.
--
-- A CORRECTION AFTER A PUSH IS NOT THE SAME AS AN UNPUSHED RECORD, and the two
-- must not share a colour. The importer only ADDS boxes BSI does not have — it
-- cannot go back and change one that is already there. So a record corrected
-- after it was pushed is marked `needs_bsi_edit` and re-running the import will
-- not clear it: somebody has to change that box in BSI by hand. Letting it go
-- green on a re-run would be a green light over work that never landed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Ladders learn what fall protection already knew ──────────────────────
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS bsi_pushed_at timestamptz;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS bsi_box_ref   text;

COMMENT ON COLUMN public.inspections.bsi_pushed_at IS
  'When this exact record landed in BSI. Per record, not per work order: a '
  'work order gains ladders after it is imported, and those have not been billed.';

CREATE INDEX IF NOT EXISTS inspections_unpushed_idx
  ON public.inspections (account_id, work_order_id)
  WHERE is_current AND NOT is_deleted AND bsi_pushed_at IS NULL;

-- ── 2. Who may correct, and in whose account ────────────────────────────────
-- `require_lead()` resolves the account from the caller's own membership, so
-- it predates impersonation: an office lead acting as a subcontractor would be
-- handed their OWN account and would not find the record they are looking at.
-- This asks the same question about the ROLE and takes the account from
-- my_account_id(), which follows an impersonation session. Removed crew are
-- not leads of anything.
CREATE OR REPLACE FUNCTION public.require_lead_account() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT role INTO v_role FROM public.account_members
   WHERE user_id = auth.uid() AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'No account — contact your administrator'; END IF;
  IF v_role <> 'lead' THEN
    RAISE EXCEPTION 'Only a lead technician can correct field records';
  END IF;
  RETURN public.my_account_id();
END;
$$;
REVOKE ALL ON FUNCTION public.require_lead_account() FROM PUBLIC;
GRANT  ALL ON FUNCTION public.require_lead_account() TO authenticated;

-- ── 3. The ladder audit trail ───────────────────────────────────────────────
-- Mirrors fp_record_audit rather than sharing it: that table's rows are keyed
-- to fall protection inspections, and one table holding two kinds of id with
-- neither constrained is how an audit trail stops being evidence.
CREATE TABLE IF NOT EXISTS public.inspection_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  inspection_id uuid,
  serial_num    text,
  action        text NOT NULL CHECK (action IN ('amend','delete','restore')),
  reason        text NOT NULL,
  before        jsonb,
  after         jsonb,
  actor_id      uuid,
  actor_name    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspection_audit_account_idx
  ON public.inspection_audit (account_id, created_at DESC);

ALTER TABLE public.inspection_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_audit_read ON public.inspection_audit;
CREATE POLICY inspection_audit_read ON public.inspection_audit
  FOR SELECT TO authenticated USING (public.can_see(account_id));
-- Written only by the SECURITY DEFINER functions below, as the records are.
REVOKE INSERT, UPDATE, DELETE ON public.inspection_audit FROM authenticated;
GRANT  SELECT ON public.inspection_audit TO authenticated;

-- ── 4. Correcting a ladder record ───────────────────────────────────────────
-- Supersedes rather than overwrites, exactly as amend_fp_inspection does: the
-- old row stays, marked, and the new one carries version + 1.
--
-- What the tech OBSERVED is amendable here and is not in fall protection,
-- because a ladder's flags and parts are description of the item and its
-- repair, not answers to a checklist that a certificate presents as having
-- been asked on the day. Who collected it never changes; the corrector is in
-- the audit row, which is where they belong.
CREATE OR REPLACE FUNCTION public.amend_inspection(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'inspection_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_prev    public.inspections%ROWTYPE;
  v_new     uuid;
  v_who     text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this record is being corrected'; END IF;

  SELECT * INTO v_prev FROM public.inspections
   WHERE id = v_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such inspection'; END IF;
  IF v_prev.is_deleted THEN RAISE EXCEPTION 'That record was deleted; restore it before correcting it'; END IF;
  IF NOT v_prev.is_current THEN RAISE EXCEPTION 'That is a superseded version; correct the current one'; END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  UPDATE public.inspections SET is_current = false, updated_at = now() WHERE id = v_prev.id;

  INSERT INTO public.inspections (
    serial_num, inspection_date, tech_name, work_order_id, next_due_date, notes,
    brand, type, length, account_id, asset_id, tech_user_id,
    version, supersedes, is_current, source, captured_at,
    lubricated, has_leveler, has_claw, has_vrung,
    rep_number, collected_by, collector_name, parts,
    -- Deliberately NOT carried over. The new version has not been to BSI,
    -- whatever happened to the one it replaces — that is the whole point of
    -- the orange state.
    bsi_pushed_at, bsi_box_ref
  ) VALUES (
    coalesce(nullif(p->>'serial_num',''), v_prev.serial_num),
    coalesce((p->>'inspection_date')::date, v_prev.inspection_date),
    v_prev.tech_name,
    coalesce(nullif(p->>'work_order_id',''), v_prev.work_order_id),
    coalesce((p->>'next_due_date')::date, v_prev.next_due_date),
    coalesce(p->>'notes',  v_prev.notes),
    coalesce(nullif(p->>'brand',''),  v_prev.brand),
    coalesce(nullif(p->>'type',''),   v_prev.type),
    coalesce(nullif(p->>'length',''), v_prev.length),
    v_account, v_prev.asset_id, v_prev.tech_user_id,
    v_prev.version + 1, v_prev.id, true,
    'office_amend',
    v_prev.captured_at,
    -- A flag is tri-state: absent from the payload means "leave it alone",
    -- and null means "the tech did not assess this". `p ? 'key'` tells the
    -- two apart, which coalesce cannot.
    CASE WHEN p ? 'lubricated'  THEN (p->>'lubricated')::boolean  ELSE v_prev.lubricated  END,
    CASE WHEN p ? 'has_leveler' THEN (p->>'has_leveler')::boolean ELSE v_prev.has_leveler END,
    CASE WHEN p ? 'has_claw'    THEN (p->>'has_claw')::boolean    ELSE v_prev.has_claw    END,
    CASE WHEN p ? 'has_vrung'   THEN (p->>'has_vrung')::boolean   ELSE v_prev.has_vrung   END,
    v_prev.rep_number, v_prev.collected_by, v_prev.collector_name,
    CASE WHEN p ? 'parts' THEN p->'parts' ELSE v_prev.parts END,
    NULL, NULL
  )
  RETURNING id INTO v_new;

  INSERT INTO public.inspection_audit
    (account_id, inspection_id, serial_num, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_new, v_prev.serial_num, 'amend', v_reason,
          row_to_json(v_prev)::jsonb,
          (SELECT row_to_json(i)::jsonb FROM public.inspections i WHERE i.id = v_new),
          auth.uid(), v_who);

  RETURN (SELECT row_to_json(i) FROM public.inspections i WHERE i.id = v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.amend_inspection(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.amend_inspection(jsonb) TO authenticated;

-- ── 5. Removing one, and putting it back ────────────────────────────────────
-- Soft, as fall protection is. The row stays and the certificate history with
-- it; what changes is whether it counts. Promotion is per (asset, date) so
-- deleting v3 of a day's record brings v2 of THAT DAY back, not last year's.
CREATE OR REPLACE FUNCTION public.delete_inspection(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'inspection_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_prev    public.inspections%ROWTYPE;
  v_who     text;
  v_back    uuid;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this record is being deleted'; END IF;

  SELECT * INTO v_prev FROM public.inspections
   WHERE id = v_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such inspection'; END IF;
  IF v_prev.is_deleted THEN RETURN (SELECT row_to_json(i) FROM public.inspections i WHERE i.id = v_id); END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  UPDATE public.inspections
     SET is_deleted = true, is_current = false, updated_at = now()
   WHERE id = v_prev.id;

  SELECT id INTO v_back FROM public.inspections
   WHERE account_id = v_account AND asset_id IS NOT DISTINCT FROM v_prev.asset_id
     AND serial_num = v_prev.serial_num
     AND inspection_date = v_prev.inspection_date
     AND NOT is_deleted AND id <> v_prev.id
   ORDER BY version DESC LIMIT 1;
  IF v_back IS NOT NULL THEN
    UPDATE public.inspections SET is_current = true, updated_at = now() WHERE id = v_back;
  END IF;

  INSERT INTO public.inspection_audit
    (account_id, inspection_id, serial_num, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_prev.id, v_prev.serial_num, 'delete', v_reason,
          row_to_json(v_prev)::jsonb, NULL, auth.uid(), v_who);

  RETURN json_build_object('deleted', v_prev.id, 'promoted', v_back);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_inspection(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.delete_inspection(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_inspection(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_id      uuid := nullif(p->>'inspection_id','')::uuid;
  v_reason  text := nullif(btrim(coalesce(p->>'reason','')), '');
  v_prev    public.inspections%ROWTYPE;
  v_who     text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why this record is being restored'; END IF;

  SELECT * INTO v_prev FROM public.inspections
   WHERE id = v_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such inspection'; END IF;

  SELECT coalesce(u.name, u.email) INTO v_who FROM public.users u WHERE u.id = auth.uid();

  -- Whatever else is standing for this serial on this date steps down: two
  -- current rows for one day is what every read in the app assumes cannot be.
  UPDATE public.inspections SET is_current = false, updated_at = now()
   WHERE account_id = v_account AND serial_num = v_prev.serial_num
     AND inspection_date = v_prev.inspection_date AND is_current AND id <> v_prev.id;

  UPDATE public.inspections
     SET is_deleted = false, is_current = true, updated_at = now()
   WHERE id = v_prev.id;

  INSERT INTO public.inspection_audit
    (account_id, inspection_id, serial_num, action, reason, before, after, actor_id, actor_name)
  VALUES (v_account, v_prev.id, v_prev.serial_num, 'restore', v_reason,
          row_to_json(v_prev)::jsonb,
          (SELECT row_to_json(i)::jsonb FROM public.inspections i WHERE i.id = v_prev.id),
          auth.uid(), v_who);

  RETURN (SELECT row_to_json(i) FROM public.inspections i WHERE i.id = v_prev.id);
END;
$$;
REVOKE ALL ON FUNCTION public.restore_inspection(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.restore_inspection(jsonb) TO authenticated;

-- ── 6. Recording that a ladder box landed ───────────────────────────────────
-- Called per box DURING a run, not at the end, for the same reason
-- mark_fp_bsi_pushed is: a crash at item 20 of 40 must leave the database
-- knowing those 20 went in, or the re-run bills them twice.
CREATE OR REPLACE FUNCTION public.mark_bsi_pushed(p jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_account uuid := public.my_account_id(); v_n integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.inspections i
     SET bsi_pushed_at = now(),
         bsi_box_ref   = coalesce(e->>'box_ref', i.bsi_box_ref),
         updated_at    = now()
    FROM jsonb_array_elements(coalesce(p->'items','[]'::jsonb)) e
   WHERE i.id = (e->>'inspection_id')::uuid
     AND i.account_id = v_account
     AND i.is_current AND NOT i.is_deleted;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_bsi_pushed(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.mark_bsi_pushed(jsonb) TO authenticated;

-- ── 7. Filing a work order away, and pulling it back ────────────────────────
-- Archive is the lead saying "this is approved and done with". It is not a
-- delete and it is not a billing fact: `charged_at` is untouched.
--
-- A work order captured purely in the field has no work_orders row — only the
-- importer and the job board create those — so archiving makes one. That is
-- also what gives the row a wo_key, which is how everything else in the app
-- matches `WO 1234` to `WO-1234`.
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS archived_by uuid;

CREATE OR REPLACE FUNCTION public.set_work_order_archived(p jsonb) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_account uuid := public.require_lead_account();
  v_wo      text := nullif(btrim(coalesce(p->>'work_order_id','')), '');
  v_on      boolean := coalesce((p->>'archived')::boolean, true);
  v_key     text;
  v_scope   text := coalesce(nullif(p->>'scope',''), 'ladder');
  v_id      uuid;
BEGIN
  IF v_wo IS NULL THEN RAISE EXCEPTION 'A work order number is required'; END IF;
  v_key := public.wo_key(v_wo);

  INSERT INTO public.work_orders (account_id, wo_number, wo_key, scope, created_by)
  VALUES (v_account, v_wo, v_key, v_scope, auth.uid())
  ON CONFLICT (account_id, wo_key) DO NOTHING;

  UPDATE public.work_orders
     SET archived_at = CASE WHEN v_on THEN now() ELSE NULL END,
         archived_by = CASE WHEN v_on THEN auth.uid() ELSE NULL END,
         updated_at  = now()
   WHERE account_id = v_account AND wo_key = v_key
  RETURNING id INTO v_id;

  RETURN json_build_object('work_order_id', v_wo, 'id', v_id, 'archived', v_on);
END;
$$;
REVOKE ALL ON FUNCTION public.set_work_order_archived(jsonb) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.set_work_order_archived(jsonb) TO authenticated;

-- ── 8. The list the screen draws ────────────────────────────────────────────
-- One row per work order that carries field records, with the state derived.
--
--   total        current, undeleted records of both kinds
--   pushed       of those, how many have reached BSI
--   stale        pushed, then corrected — the importer CANNOT fix these, so
--                they are counted apart and named apart
--   processed_at when the last box landed
--
-- `p_archived` picks the screen: false is Field Work, true is Work History.
CREATE OR REPLACE FUNCTION public.field_work_orders(p_archived boolean DEFAULT false)
RETURNS TABLE (
  work_order_id text, scope text, total integer, pushed integer, stale integer,
  processed_at timestamptz, last_captured_at timestamptz,
  archived_at timestamptz, archived_by_name text, techs json, state text
)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_account uuid := public.my_account_id();
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  WITH rec AS (
    SELECT i.work_order_id AS wo, 'ladder'::text AS sc, i.bsi_pushed_at,
           i.captured_at, i.collector_name AS who, i.supersedes
      FROM public.inspections i
     WHERE public.can_see(i.account_id) AND i.account_id = v_account
       AND i.is_current AND NOT i.is_deleted AND i.work_order_id IS NOT NULL
    UNION ALL
    SELECT f.work_order_id, 'fall_protection', f.bsi_pushed_at,
           f.captured_at, f.collector_name, f.supersedes
      FROM public.fp_inspections f
     WHERE public.can_see(f.account_id) AND f.account_id = v_account
       AND f.is_current AND NOT f.is_deleted AND f.work_order_id IS NOT NULL
  ),
  agg AS (
    SELECT r.wo,
           string_agg(DISTINCT r.sc, ',' ORDER BY r.sc)          AS scopes,
           count(*)::integer                                     AS total,
           count(r.bsi_pushed_at)::integer                       AS pushed,
           -- Superseding a record that had been pushed is the case the
           -- importer cannot repair by re-running.
           count(*) FILTER (WHERE r.bsi_pushed_at IS NULL
                              AND r.supersedes IS NOT NULL)::integer AS stale,
           max(r.bsi_pushed_at)                                  AS processed_at,
           max(r.captured_at)                                    AS last_captured_at,
           coalesce(json_agg(DISTINCT r.who) FILTER (WHERE r.who IS NOT NULL), '[]'::json) AS techs
      FROM rec r GROUP BY r.wo
  )
  SELECT a.wo, a.scopes, a.total, a.pushed, a.stale,
         a.processed_at, a.last_captured_at,
         w.archived_at,
         (SELECT coalesce(u.name, u.email) FROM public.users u WHERE u.id = w.archived_by),
         a.techs,
         CASE WHEN a.pushed = 0        THEN 'needs_processing'
              WHEN a.stale  > 0        THEN 'needs_bsi_edit'
              WHEN a.pushed < a.total  THEN 'has_edits'
              ELSE                          'processed' END
    FROM agg a
    LEFT JOIN public.work_orders w
           ON w.account_id = v_account AND w.wo_key = public.wo_key(a.wo)
   WHERE (w.archived_at IS NOT NULL) = p_archived
   ORDER BY coalesce(a.last_captured_at, a.processed_at) DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.field_work_orders(boolean) FROM PUBLIC;
GRANT  ALL ON FUNCTION public.field_work_orders(boolean) TO authenticated;
