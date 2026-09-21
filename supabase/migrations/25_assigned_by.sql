-- ═══════════════════════════════════════════════════════════════════════════
-- Lia — an assigned job says who assigned it; safe to re-run, idempotent
--
-- Run AFTER 24_field_parts.sql.
--
-- A tech opening the app sees the work his lead planned for him, and had no
-- way to tell who that was. On a phone shared between techs — or a tech
-- working under more than one lead — "who gave me this?" is the first question
-- and the answer was nowhere on the device.
--
-- Re-emitted from 16 with two fields added: the name and address of whoever
-- created the job. Nothing else changes, and nothing new is exposed: the job
-- is already visible to this tech, and its author is a member of the same
-- account.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.my_jobs(p_closed_days integer DEFAULT 2)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public AS $$
DECLARE
  v_account uuid := public.my_account_id();
  v_uid     uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN (
    SELECT coalesce(json_agg(json_build_object(
             'id', j.id,
             'wo_number', j.wo_number,
             'wo_key', j.wo_key,
             'scope', j.scope,
             'title', j.title,
             'site', j.site,
             'notes', j.notes,
             'due_date', j.due_date,
             'status', j.status,
             'share_peer_work', j.share_peer_work,
             'assigned_to_me', EXISTS (
               SELECT 1 FROM public.job_assignees ja
                WHERE ja.job_id = j.id AND ja.user_id = v_uid),
             'team_wide', j.assign_all,
             'mine_count', (
               SELECT coalesce(sum(pr.n), 0)::int FROM public.job_progress(v_account, j.wo_key, j.scope) pr
                WHERE pr.user_id IS NOT DISTINCT FROM v_uid),
             -- Only meaningful when sharing is on, and zero rather than a lie
             -- when it is off.
             'team_count', CASE WHEN j.share_peer_work THEN (
               SELECT coalesce(sum(pr.n), 0)::int FROM public.job_progress(v_account, j.wo_key, j.scope) pr)
               ELSE 0 END,
             -- Who planned this. On a shared phone, and on any phone whose
             -- tech works for more than one lead, "who told me to do this"
             -- is the first question and there was no answer on the device.
             'assigned_by', (
               SELECT coalesce(u.name, u.email) FROM public.users u WHERE u.id = j.created_by),
             'assigned_by_email', (
               SELECT u.email FROM public.users u WHERE u.id = j.created_by),
             'updated_at', j.updated_at
           ) ORDER BY j.status, j.due_date NULLS LAST, j.updated_at DESC), '[]'::json)
      FROM public.jobs j
     WHERE j.account_id = v_account
       AND (j.assign_all OR EXISTS (
             SELECT 1 FROM public.job_assignees ja
              WHERE ja.job_id = j.id AND ja.user_id = v_uid))
       AND (j.status = 'open'
            OR (j.status <> 'open' AND j.closed_at > now() - make_interval(days => greatest(0, coalesce(p_closed_days, 2)))))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.my_jobs(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_jobs(integer) TO authenticated;
