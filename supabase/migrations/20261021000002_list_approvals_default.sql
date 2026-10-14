-- Phase 8: found by the authorization matrix. A staff member listing approvals without naming a scope was refused (the old default, 'inbox', is manager-only). The default now suits the caller.
drop function if exists public.list_approvals(uuid, text, text, text, integer, integer);
create or replace function public.list_approvals(p_org uuid, p_scope text default null, p_status text default null, p_action text default null, p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.org_role;
begin
  v_role := app.require_role(p_org, 'staff');
  p_scope := coalesce(p_scope, case when app.role_rank(v_role) >= app.role_rank('manager') then 'inbox' else 'mine' end);   -- staff see their own requests by default
  if p_scope not in ('inbox', 'mine', 'all') then raise exception 'invalid scope' using errcode = 'PT422'; end if;
  if p_scope in ('inbox', 'all') and app.role_rank(v_role) < app.role_rank('manager') then raise exception 'insufficient role' using errcode = 'PT403'; end if;
  return (with filtered as (
      select a.*, case when a.status in ('pending', 'approved') and a.expires_at <= now() then 'expired' else a.status::text end as eff
      from public.approvals a where a.org_id = p_org
        and (p_scope = 'all' or (p_scope = 'mine' and a.requested_by = auth.uid()) or (p_scope = 'inbox' and a.status = 'pending' and a.expires_at > now() and (a.requested_by <> auth.uid() or (select allow_self_approval from public.maintenance_settings where org_id = p_org))
              and app.role_rank(v_role) >= app.role_rank((select approve_min_role from public.approval_actions x where x.action_type = a.action_type))))
        and (p_action is null or a.action_type = p_action))
    select jsonb_build_object('total', (select count(*) from filtered where p_status is null or eff = p_status),
      'pending_for_me', (select count(*) from public.approvals a where a.org_id = p_org and a.status = 'pending' and a.expires_at > now() and (a.requested_by <> auth.uid() or (select allow_self_approval from public.maintenance_settings where org_id = p_org))
                           and app.role_rank(v_role) >= app.role_rank((select approve_min_role from public.approval_actions x where x.action_type = a.action_type))),
      'items', coalesce((select jsonb_agg(app.approval_json(q::public.approvals, auth.uid()) order by q.requested_at desc)
                          from (select a2.* from public.approvals a2 where a2.id in (select id from filtered where p_status is null or eff = p_status)
                                 order by a2.requested_at desc limit app.page_limit(p_limit) offset app.page_offset(p_offset)) q), '[]'::jsonb)));
end $$;

grant execute on function public.list_approvals(uuid, text, text, text, integer, integer) to authenticated;
