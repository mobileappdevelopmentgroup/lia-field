-- 2026-11-13 — READ-ONLY. Changes nothing. One statement, so the SQL editor
-- shows all of it.
--
-- Every work order any account has, with: when it was created and charged (a
-- charge means Lia Office imported it into BSI successfully), how many ladder
-- records sit behind it split by where they came from (phone vs Lia Office),
-- and fall-protection records. A charged work order with 0 office and 0 field
-- ladders is an import whose records never reached the database.
--
-- Plus one row per account for ladder records with NO work order at all.

WITH wo AS (
  SELECT w.account_id, w.wo_number, public.wo_key(w.wo_number) AS k,
         w.scope, w.created_at::date AS created, w.charged_at::date AS charged,
         w.credits_charged
    FROM public.work_orders w
),
lad AS (
  SELECT account_id, public.wo_key(coalesce(work_order_id, '')) AS k,
         count(*) FILTER (WHERE coalesce(source,'') LIKE 'office%') AS office_ladders,
         count(*) FILTER (WHERE coalesce(source,'') NOT LIKE 'office%') AS other_ladders,
         string_agg(DISTINCT coalesce(source, '(none)'), ', ') AS sources,
         min(inspection_date) AS first_insp, max(inspection_date) AS last_insp
    FROM public.inspections
   WHERE is_current AND NOT is_deleted
   GROUP BY 1, 2
),
fp AS (
  SELECT account_id, public.wo_key(coalesce(work_order_id, '')) AS k, count(*) AS fp
    FROM public.fp_inspections
   WHERE is_current AND NOT is_deleted
   GROUP BY 1, 2
)
SELECT ac.name                                   AS account,
       coalesce(wo.wo_number, '(' || nullif(lad.k, '') || ')', '(no work order)') AS work_order,
       wo.scope, wo.created, wo.charged, wo.credits_charged,
       coalesce(lad.office_ladders, 0)           AS office_ladders,
       coalesce(lad.other_ladders, 0)            AS phone_or_other_ladders,
       lad.sources,
       coalesce(fp.fp, 0)                        AS fp,
       lad.first_insp, lad.last_insp
  FROM wo
  FULL JOIN lad ON lad.account_id = wo.account_id AND lad.k = wo.k
  LEFT JOIN fp  ON fp.account_id = coalesce(wo.account_id, lad.account_id)
               AND fp.k = coalesce(wo.k, lad.k)
  LEFT JOIN public.accounts ac ON ac.id = coalesce(wo.account_id, lad.account_id)
 ORDER BY ac.name, coalesce(wo.created, lad.first_insp);
