-- 2026-11-12 — READ-ONLY. Changes nothing.
--
-- The public certificate pages show every current, non-deleted record in the
-- database, for every account (ladder_inspections_public,
-- fall_protection_public). From outside, on 2026-11-12, that was 3,613 ladder
-- and 623 fall-protection certificates — and no fall protection at all for
-- Michael. If there should be more, they are either in the database but not
-- current (deleted / superseded / never linked to an item), sitting as
-- unverified sheet claims, or were never loaded. This tells which.
--
-- Paste into Supabase → SQL editor. Each SELECT is its own result tab.

-- 1. Per account: what exists vs what is public.
SELECT ac.name,
       coalesce(p.name, '—')                                                   AS umbrella,
       (SELECT count(*) FROM inspections i WHERE i.account_id = ac.id)          AS ladder_rows,
       (SELECT count(*) FROM inspections i WHERE i.account_id = ac.id
           AND i.is_current AND NOT i.is_deleted)                               AS ladder_public,
       (SELECT count(*) FROM inspections i WHERE i.account_id = ac.id
           AND i.is_deleted)                                                    AS ladder_deleted,
       (SELECT count(*) FROM inspections i WHERE i.account_id = ac.id
           AND i.asset_id IS NULL)                                              AS ladder_no_item,
       (SELECT count(*) FROM fp_inspections f WHERE f.account_id = ac.id)       AS fp_rows,
       (SELECT count(*) FROM fp_inspections f WHERE f.account_id = ac.id
           AND f.is_current AND NOT f.is_deleted)                               AS fp_public,
       (SELECT count(*) FROM fp_inspections f WHERE f.account_id = ac.id
           AND f.is_deleted)                                                    AS fp_deleted,
       (SELECT count(*) FROM assets a WHERE a.account_id = ac.id
           AND a.kind = 'fall_protection')                                      AS fp_items,
       (SELECT count(*) FROM fp_external_records e WHERE e.account_id = ac.id)  AS fp_sheet_claims,
       (SELECT count(*) FROM fp_tag_stock t WHERE t.account_id = ac.id)         AS tags_held,
       (SELECT count(*) FROM work_orders w WHERE w.account_id = ac.id)          AS work_orders,
       (SELECT count(*) FROM usage_log u WHERE u.account_id = ac.id)            AS billed_runs
  FROM accounts ac LEFT JOIN accounts p ON p.id = ac.parent_account_id
 ORDER BY ac.name;

-- 2. Ladders with no account at all (pre-licensing rows never assigned).
SELECT count(*) AS ladder_rows_without_account,
       count(*) FILTER (WHERE is_current AND NOT is_deleted) AS of_which_public
  FROM inspections WHERE account_id IS NULL;

-- 3. Work orders that were billed but have no ladder or FP record behind them
--    — imported into BSI through Lia Office, but the records never landed.
SELECT ac.name, u.work_order_id, min(u.consumed_at)::date AS billed_on,
       (SELECT count(*) FROM inspections i
         WHERE i.account_id = u.account_id
           AND public.wo_key(i.work_order_id) = public.wo_key(u.work_order_id)) AS ladders,
       (SELECT count(*) FROM fp_inspections f
         WHERE f.account_id = u.account_id
           AND public.wo_key(f.work_order_id) = public.wo_key(u.work_order_id)) AS fp
  FROM usage_log u LEFT JOIN accounts ac ON ac.id = u.account_id
 GROUP BY ac.name, u.account_id, u.work_order_id
HAVING (SELECT count(*) FROM inspections i
         WHERE i.account_id = u.account_id
           AND public.wo_key(i.work_order_id) = public.wo_key(u.work_order_id)) = 0
 ORDER BY billed_on;

-- 4. Fall-protection sheet claims (tags tapped whose Google Sheet was read but
--    never became an inspection). These are never shown on a certificate.
SELECT ac.name, count(*) AS claims, count(DISTINCT e.source_url_key) AS distinct_tags,
       min(e.claimed_inspection_date) AS earliest, max(e.claimed_inspection_date) AS latest,
       count(*) FILTER (WHERE e.asset_id IS NULL) AS not_linked_to_an_item
  FROM fp_external_records e JOIN accounts ac ON ac.id = e.account_id
 GROUP BY ac.name ORDER BY 1;

-- 5. Test records that are on the public pages today.
SELECT ac.name, i.serial_num, i.inspection_date, i.work_order_id,
       coalesce(i.rep_name, i.tech_name) AS shown_as, i.collector_name, i.source
  FROM inspections i LEFT JOIN accounts ac ON ac.id = i.account_id
 WHERE i.is_current AND NOT i.is_deleted
   AND (coalesce(i.rep_name, i.tech_name) ILIKE 'Alex%'
        OR i.work_order_id IN ('WO-12345','WO-45678','123456','62453','97320'))
 ORDER BY ac.name, i.serial_num;
