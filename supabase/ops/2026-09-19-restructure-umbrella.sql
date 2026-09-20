-- ═══════════════════════════════════════════════════════════════════════════
-- Put the live accounts into the umbrella shape.
--
-- Run AFTER migrations 18, 19, 20 and 21 are applied, and AFTER
-- 2026-09-19-michael-dobbs-account.sql (which gave Michael his own account).
--
-- Before                                  After
--   Batavia                                 Batavia  (umbrella — no work of
--     ├ Nate    lead, rep 734                          its own)
--     ├ Alex    tech                          ├ Nate Dobbs     lead, rep 734
--     └ 1,724 inspections + their assets      │   └ 1,724 inspections + assets
--   Michael Dobbs (no parent)                 └ Michael Dobbs  lead, rep 738
--     └ lead, rep 738, no work
--                                           Alex: lead of Batavia, sees all,
--                                                 can act as either.
--
-- ⚠️ THE WORK MOVES. Those 1,724 records are Nate's operation and go with him.
-- This is not cosmetic: assets carry serials that are unique PER ACCOUNT and
-- `public_ref` codes that are printed on tags already riveted to customer
-- equipment. Moving an inspection without its asset, or an asset without its
-- inspections, breaks a certificate lookup for equipment nobody can reach.
-- Everything is moved together, in one transaction.
--
-- What does NOT move: the catalogue (fp_models, fp_equipment_types,
-- known_networks). Those stay with Batavia, because under 18 the catalogue
-- flows DOWN — one definition, inherited by every subcontractor. Moving them
-- to Nate would take them away from Michael.
--
-- Run it exactly like the other ops script: PASS 1 as it stands (nothing is
-- kept, read the result), then add COMMIT; and run again.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _before ON COMMIT DROP AS
SELECT a.name AS account, a.parent_account_id,
       (SELECT count(*) FROM public.inspections i WHERE i.account_id = a.id)    AS inspections,
       (SELECT count(*) FROM public.assets s WHERE s.account_id = a.id)         AS assets,
       (SELECT count(*) FROM public.account_members m WHERE m.account_id = a.id) AS members
  FROM public.accounts a;

DO $$
DECLARE
  c_batavia constant uuid := '265882ec-0c13-44ef-9648-4b0a73375bf5';
  c_alex    constant uuid := 'a8738ff3-412e-4369-8298-6fc37aa9a1b2';
  c_nate    constant uuid := 'd7bdb210-ae3d-4560-8de0-49ea73d09d80';
  c_michael constant uuid := '5085df63-6e29-4088-af9f-24ae1be29334';
  v_nate_acct    uuid;
  v_michael_acct uuid;
  v_moved        integer;
BEGIN
  -- ── Preconditions. Each of these is a way the live database could differ
  -- from what this script assumes, and every one of them would corrupt the
  -- result rather than fail loudly later.
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = c_batavia) THEN
    RAISE EXCEPTION 'Batavia account % not found', c_batavia;
  END IF;
  IF to_regclass('public.impersonation_sessions') IS NULL THEN
    RAISE EXCEPTION 'Migrations 18-21 are not applied yet — apply them first.';
  END IF;
  IF (SELECT account_id FROM public.account_members WHERE user_id = c_nate) IS DISTINCT FROM c_batavia THEN
    RAISE EXCEPTION 'Nate is not in Batavia''s account — check the live state before running this.';
  END IF;

  SELECT account_id INTO v_michael_acct FROM public.account_members WHERE user_id = c_michael;
  IF v_michael_acct IS NULL OR v_michael_acct = c_batavia THEN
    RAISE EXCEPTION 'Michael does not have his own account yet — run 2026-09-19-michael-dobbs-account.sql first.';
  END IF;

  -- ── 1. Michael hangs under the umbrella ───────────────────────────────────
  UPDATE public.accounts SET parent_account_id = c_batavia
   WHERE id = v_michael_acct AND parent_account_id IS DISTINCT FROM c_batavia;

  -- ── 2. Nate gets his own company, under the umbrella ──────────────────────
  -- Unlimited, matching what he has been working under. Subcontractors are
  -- billed on their own account, so this is a deliberate choice, not inherited.
  SELECT account_id INTO v_nate_acct FROM public.account_members WHERE user_id = c_nate;

  IF v_nate_acct = c_batavia THEN
    INSERT INTO public.accounts (name, credits, parent_account_id)
    VALUES ('Nate Dobbs', -1, c_batavia)
    RETURNING id INTO v_nate_acct;

    UPDATE public.account_members
       SET account_id = v_nate_acct, role = 'lead', desktop_access = true, rep_number = '734'
     WHERE user_id = c_nate;

    RAISE NOTICE 'Created % for Nate', v_nate_acct;
  END IF;

  -- ── 3. The work moves with him ────────────────────────────────────────────
  -- Order does not matter inside one transaction, but assets and inspections
  -- MUST both move or neither: a certificate is looked up through the asset.
  UPDATE public.assets                 SET account_id = v_nate_acct WHERE account_id = c_batavia;
  GET DIAGNOSTICS v_moved = ROW_COUNT;  RAISE NOTICE 'assets moved: %', v_moved;

  UPDATE public.inspections            SET account_id = v_nate_acct WHERE account_id = c_batavia;
  GET DIAGNOSTICS v_moved = ROW_COUNT;  RAISE NOTICE 'inspections moved: %', v_moved;

  UPDATE public.fp_inspections         SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.inspection_photos      SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.fp_external_records    SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.fp_tag_links           SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.fp_tag_writes          SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.fp_record_audit        SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.work_orders            SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.usage_log              SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.jobs                   SET account_id = v_nate_acct WHERE account_id = c_batavia;
  UPDATE public.certificate_views      SET account_id = v_nate_acct WHERE account_id = c_batavia;

  -- Deliberately NOT moved:
  --   fp_models, fp_equipment_types, known_networks — the catalogue and the
  --     network labels stay with Batavia and flow down to both subcontractors.
  --   support_tickets — a ticket belongs to whoever wrote it.
  --   account_members — handled above, per person.

  -- ── 4. Alex runs the umbrella ─────────────────────────────────────────────
  -- Lead of Batavia: sees every subcontractor's work, can correct it, and can
  -- act as either of them. No rep number — he is not the technician of record
  -- for anybody's inspection, and a number here would put him on certificates.
  UPDATE public.account_members
     SET account_id = c_batavia, role = 'lead', desktop_access = true, rep_number = NULL
   WHERE user_id = c_alex;

  IF NOT FOUND THEN
    RAISE WARNING 'No membership row for Alex (%) — check the user id.', c_alex;
  END IF;

  -- ── 5. Attribution catches up ─────────────────────────────────────────────
  -- 19 stamped verified_by from the tree as it was BEFORE this restructure. For
  -- rows that were Batavia's own, the answer is the same either way (Batavia is
  -- the root in both shapes) — but rep_name is worth re-deriving now that the
  -- rows sit in an account whose lead is explicitly Nate.
  UPDATE public.inspections i
     SET rep_name = r.rep_name
    FROM public.account_rep(v_nate_acct) r
   WHERE i.account_id = v_nate_acct AND i.rep_name IS NULL;

  UPDATE public.inspections SET verified_by = 'Batavia'
   WHERE account_id = v_nate_acct AND verified_by IS NULL;

  -- ── Guards ────────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.inspections WHERE account_id = c_batavia) THEN
    RAISE EXCEPTION 'Inspections are still on the umbrella account — the move did not complete.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.assets WHERE account_id = c_batavia) THEN
    RAISE EXCEPTION 'Assets are still on the umbrella account — the move did not complete.';
  END IF;
  IF (SELECT count(*) FROM public.account_members m
       JOIN public.accounts a ON a.id = m.account_id
      WHERE m.role = 'lead' AND a.parent_account_id = c_batavia
      GROUP BY m.account_id HAVING count(*) > 1) IS NOT NULL THEN
    RAISE EXCEPTION 'A subcontractor account has more than one lead.';
  END IF;
END $$;

-- ── The result, as one table ────────────────────────────────────────────────
-- Expect:
--   before/Batavia          1724 inspections, its assets, 2 members
--   after/Batavia           0 inspections, 0 assets, 1 member (you), no parent
--   after/Nate Dobbs        1724 inspections, the assets, 1 member, under Batavia
--   after/Michael Dobbs     0 inspections, 1 member, under Batavia
--   tree/…                  both subcontractors listed under the umbrella
--   sample/…                a real certificate still resolves, naming Nate
SELECT * FROM (
  SELECT 1 AS ord, 'before'::text AS what, b.account AS subject,
         b.inspections || ' inspections · ' || b.assets || ' assets · '
         || b.members || ' members' AS detail
    FROM _before b
  UNION ALL
  SELECT 2, 'after', a.name,
         (SELECT count(*) FROM public.inspections i WHERE i.account_id = a.id) || ' inspections · '
      || (SELECT count(*) FROM public.assets s WHERE s.account_id = a.id) || ' assets · '
      || (SELECT count(*) FROM public.account_members m WHERE m.account_id = a.id) || ' members · '
      || coalesce((SELECT p.name FROM public.accounts p WHERE p.id = a.parent_account_id), 'no parent')
    FROM public.accounts a
  UNION ALL
  SELECT 3, 'tree', a.name,
         'under ' || coalesce((SELECT p.name FROM public.accounts p WHERE p.id = a.parent_account_id), '—')
      || ' · lead ' || coalesce((SELECT coalesce(u.name, u.email) FROM public.account_members m
                                   JOIN public.users u ON u.id = m.user_id
                                  WHERE m.account_id = a.id AND m.role = 'lead' LIMIT 1), 'NONE')
      || ' · rep ' || coalesce((SELECT m.rep_number FROM public.account_members m
                                 WHERE m.account_id = a.id AND m.role = 'lead' LIMIT 1), '—')
    FROM public.accounts a
  UNION ALL
  -- A certificate that exists in the field today. It must still resolve, and
  -- must now name Nate as the technician and Batavia as the verifier.
  SELECT 4, 'sample', coalesce(v.serial_num, '(none found)'),
         coalesce(v.tech_name, '—') || ' · rep ' || coalesce(v.rep_number, '—')
      || ' · verified by ' || coalesce(v.verified_by, '—')
    FROM (SELECT * FROM public.ladder_inspections_public LIMIT 1) v
) x
ORDER BY ord, subject;

-- ── How to run this ─────────────────────────────────────────────────────────
--   PASS 1 — paste and run as it stands. There is no COMMIT, so the whole
--            thing is rolled back when the editor's session ends. Read the
--            table; this is the dry run, and it moves 1,724 live records.
--   PASS 2 — add COMMIT; as the last line and run again.
--
-- If pass 1 raises, nothing has happened and the message says which assumption
-- about the live database was wrong.
