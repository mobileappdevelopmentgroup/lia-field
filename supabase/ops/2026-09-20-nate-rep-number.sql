-- ═══════════════════════════════════════════════════════════════════════════
-- Correct Nate Dobbs's technician number: 734 → 763.
--
-- Not a migration. A correction to one person's record, run once in the
-- Supabase SQL editor.
--
-- ── Why this is two changes, not one ───────────────────────────────────────
-- `rep_number` is SNAPSHOTTED onto every inspection when it is written, so
-- that reassigning a number later cannot rewrite certificates already issued.
-- That is the right rule — and it means changing his profile alone leaves
-- 1,724 existing certificates printing 734.
--
-- So c_backfill decides what this script is:
--
--   true   734 was a MISTAKE. It was never his number, so every record
--          carrying it is wrong and gets corrected. Certificates already in
--          customers' hands change what they display — which is the point.
--   false  734 was correct for the work already recorded and 763 applies from
--          now on. History keeps what was true at the time.
--
-- Set it deliberately. The backfill is scoped to HIS account, so it cannot
-- touch another company's records even if they happened to use 734.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  c_old      constant text := '734';
  c_new      constant text := '763';
  c_email    constant text := 'nathandobbs@me.com';
  c_backfill constant boolean := true;      -- ← read the header before changing

  v_user     uuid;
  v_account  uuid;
  v_current  text;
  v_n        integer;
BEGIN
  SELECT u.id, m.account_id, m.rep_number INTO v_user, v_account, v_current
    FROM public.users u
    JOIN public.account_members m ON m.user_id = u.id
   WHERE u.email = c_email;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No user for % — check the address.', c_email;
  END IF;

  -- Already done, or never what this script assumed. Either way, stop rather
  -- than move a number this script did not put there.
  IF v_current = c_new THEN
    RAISE NOTICE 'Already %; nothing to change on the membership.', c_new;
  ELSIF v_current IS DISTINCT FROM c_old THEN
    RAISE EXCEPTION 'Expected % on the membership, found %. Stopping.', c_old, coalesce(v_current, 'null');
  ELSE
    UPDATE public.account_members SET rep_number = c_new WHERE user_id = v_user;
    RAISE NOTICE 'Membership: % → %', c_old, c_new;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.account_members
                  WHERE rep_number = c_new AND user_id <> v_user) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Somebody else already holds %. Two technicians cannot share a number.', c_new;
  END IF;

  IF c_backfill THEN
    -- Scoped to his own account: another company's 734 is not ours to touch.
    UPDATE public.inspections
       SET rep_number = c_new
     WHERE account_id = v_account AND rep_number = c_old;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Ladder inspections corrected: %', v_n;

    UPDATE public.fp_inspections
       SET rep_number = c_new
     WHERE account_id = v_account AND rep_number = c_old;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Fall-protection inspections corrected: %', v_n;

    -- rep_name is untouched on purpose: the NAME was never wrong, and it is
    -- what the certificate shows beside the number.
  ELSE
    RAISE NOTICE 'Backfill skipped — existing certificates keep %.', c_old;
  END IF;
END $$;

-- ── The result, as one table (the editor shows only the last) ───────────────
-- Expect:
--   member/…      Nate Dobbs · rep 763
--   ladder/763    1724 (with backfill) — or 0, and ladder/734 still 1724
--   ladder/734    0 with backfill
--   sample/…      a real certificate, now reading 763
SELECT * FROM (
  SELECT 1 AS ord, 'member'::text AS what, coalesce(u.name, u.email) AS subject,
         a.name || ' · rep ' || coalesce(m.rep_number, '—') AS detail
    FROM public.users u
    JOIN public.account_members m ON m.user_id = u.id
    JOIN public.accounts a ON a.id = m.account_id
   WHERE u.email = 'nathandobbs@me.com'
  UNION ALL
  SELECT 2, 'ladder', coalesce(i.rep_number, '(none)'), count(*)::text || ' inspections'
    FROM public.inspections i GROUP BY i.rep_number
  UNION ALL
  SELECT 3, 'fall protection', coalesce(i.rep_number, '(none)'), count(*)::text || ' inspections'
    FROM public.fp_inspections i GROUP BY i.rep_number
  UNION ALL
  SELECT 4, 'sample', coalesce(v.serial_num, '(none)'),
         coalesce(v.tech_name, '—') || ' · rep ' || coalesce(v.rep_number, '—')
      || ' · verified by ' || coalesce(v.verified_by, '—')
    FROM (SELECT * FROM public.ladder_inspections_public LIMIT 1) v
) x
ORDER BY ord, subject;

-- ── How to run this ─────────────────────────────────────────────────────────
--   PASS 1 — paste and run as it stands. There is no COMMIT, so nothing is
--            kept; read the table and the NOTICEs.
--   PASS 2 — add COMMIT; as the last line and run again.
--
-- ⚠️ With the backfill on, pass 2 changes what 1,724 live certificates display.
-- The tags themselves are unaffected: they point at `public_ref`, which this
-- script never touches.
