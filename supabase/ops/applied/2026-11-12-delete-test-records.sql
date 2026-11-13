-- 2026-11-12 — soft-delete the test ladder records on the public certificates
--
-- Test runs in September were saved against real serials, so a search for
-- e.g. 1719760 showed "Alex Test, WO-12345" as its latest inspection instead
-- of Nate's real one. Confirmed by the user 2026-11-12: every record on these
-- five work orders is a test, including Michael's WO-45678.
--
--   WO-12345  WO-45678  123456  62453  97320
--
-- From outside that is 24 current ladder records and no fall protection.
--
-- Does what delete_inspection() does (that function needs a signed-in lead):
-- marks the row deleted and not current, makes the newest surviving version of
-- the same item + date current again if there is one, and writes an
-- inspection_audit row with the full record — so it can be restored.
-- Every version on those work orders is deleted, not only the current one, so
-- an older test version cannot be promoted back onto the certificate.
--
-- Refuses (and changes nothing) unless it finds exactly 24 current records.
-- Re-running after it has worked finds 0 and stops.
--
-- Paste the whole file into Supabase → SQL editor and run.

BEGIN;

DO $$
DECLARE
  wos  text[] := ARRAY['WO-12345','WO-45678','123456','62453','97320'];
  n_cur int; n_noacct int; n_all int; n_back int;
BEGIN
  SELECT count(*) INTO n_cur FROM public.inspections
   WHERE work_order_id = ANY (wos) AND is_current AND NOT is_deleted;
  IF n_cur <> 24 THEN
    RAISE EXCEPTION 'Expected 24 current test records, found % — nothing changed', n_cur;
  END IF;

  SELECT count(*) INTO n_noacct FROM public.inspections
   WHERE work_order_id = ANY (wos) AND NOT is_deleted AND account_id IS NULL;
  IF n_noacct > 0 THEN
    RAISE EXCEPTION '% test records have no account; cannot audit them — nothing changed', n_noacct;
  END IF;

  -- Audit first, with the row as it was.
  INSERT INTO public.inspection_audit
    (account_id, inspection_id, serial_num, action, reason, before, after, actor_id, actor_name)
  SELECT i.account_id, i.id, i.serial_num, 'delete',
         'Test record (work order ' || i.work_order_id || '), removed from public certificates',
         row_to_json(i)::jsonb, NULL, NULL, 'Office (SQL, 2026-11-12)'
    FROM public.inspections i
   WHERE i.work_order_id = ANY (wos) AND NOT i.is_deleted;
  GET DIAGNOSTICS n_all = ROW_COUNT;

  CREATE TEMP TABLE _gone ON COMMIT DROP AS
  SELECT DISTINCT account_id, asset_id, serial_num, inspection_date
    FROM public.inspections
   WHERE work_order_id = ANY (wos) AND NOT is_deleted;

  UPDATE public.inspections
     SET is_deleted = true, is_current = false, updated_at = now()
   WHERE work_order_id = ANY (wos) AND NOT is_deleted;

  -- A real version of the same item and date, if one survives, is current again.
  WITH back AS (
    SELECT DISTINCT ON (g.account_id, g.asset_id, g.serial_num, g.inspection_date) i.id
      FROM _gone g
      JOIN public.inspections i
        ON i.account_id = g.account_id
       AND i.asset_id IS NOT DISTINCT FROM g.asset_id
       AND i.serial_num = g.serial_num
       AND i.inspection_date = g.inspection_date
       AND NOT i.is_deleted
     WHERE NOT EXISTS (SELECT 1 FROM public.inspections c
                        WHERE c.account_id = g.account_id
                          AND c.asset_id IS NOT DISTINCT FROM g.asset_id
                          AND c.serial_num = g.serial_num
                          AND c.inspection_date = g.inspection_date
                          AND c.is_current AND NOT c.is_deleted)
     ORDER BY g.account_id, g.asset_id, g.serial_num, g.inspection_date, i.version DESC
  )
  UPDATE public.inspections SET is_current = true, updated_at = now()
   WHERE id IN (SELECT id FROM back);
  GET DIAGNOSTICS n_back = ROW_COUNT;

  RAISE NOTICE 'Deleted % test rows (% were current); % earlier real versions made current again',
               n_all, n_cur, n_back;
END $$;

-- Check: expect 0 rows.
SELECT serial_num, inspection_date, work_order_id, tech_name
  FROM public.ladder_inspections_public
 WHERE work_order_id IN ('WO-12345','WO-45678','123456','62453','97320');

-- And what the affected serials show now (Nate's real records where they exist).
SELECT serial_num, inspection_date, work_order_id, tech_name
  FROM public.ladder_inspections_public
 WHERE serial_num IN ('1719759','1719760','1719761','1719769','1719789')
 ORDER BY serial_num, inspection_date DESC;

COMMIT;
