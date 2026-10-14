-- Phase 4 functions, part B: maintenance requests, escalation, lifecycle, work orders, estimates, notes, attachments, portal, reads.

create or replace function app.load_request(p_org uuid, p_id uuid, p_lock boolean default false) returns public.maintenance_requests
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  if p_lock then select * into r from public.maintenance_requests where id = p_id and org_id = p_org for update;
  else select * into r from public.maintenance_requests where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'request not found' using errcode = 'PT404'; end if;
  return r;
end $$;

-- 'staff' (org staff+), 'tenant' (the verified tenant who reported it), or null.
create or replace function app.request_actor(p_org uuid, p_request uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when app.has_role(p_org, 'staff') then 'staff'
              when exists (select 1 from public.maintenance_requests r where r.id = p_request and r.org_id = p_org and app.tenant_reported(r.id)) then 'tenant' end $$;

create or replace function app.actor_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$ select coalesce(nullif(full_name, ''), email) from public.profiles where id = p_user $$;

create or replace function app.keyword_hit(p_org uuid, p_text text) returns text
language sql stable security definer set search_path = '' as $$
  select k from unnest((select critical_keywords from public.maintenance_settings where org_id = p_org)) k
   where k <> '' and position(lower(k) in lower(p_text)) > 0 order by char_length(k) desc limit 1 $$;

create or replace function app.system_note(p_req public.maintenance_requests, p_body text, p_visibility public.note_visibility default 'internal') returns void
language sql security definer set search_path = '' as $$
  insert into public.maintenance_notes (org_id, request_id, author_kind, visibility, body) values (p_req.org_id, p_req.id, 'system', p_visibility, p_body) $$;

-- Tell whoever raised the request (and the tenant's verified portal users) about a change.
create or replace function app.notify_requester(p_req public.maintenance_requests, p_event text, p_title text, p_body text, p_dedupe text, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid;
begin
  for u in select distinct x from (select p_req.reported_by as x
           union select tu.user_id from public.tenant_users tu where tu.tenant_id = p_req.tenant_id and tu.revoked_at is null) s where x is distinct from p_actor loop
    perform app.notify_user(p_req.org_id, u, p_event, p_title, p_body,
      case when app.role_of_user(p_req.org_id, u) is null then '/portal' else '/app?org=' || p_req.org_id || '#/maintenance/' || p_req.id end, p_dedupe);
  end loop;
end $$;

create or replace function app.log_status(p_req public.maintenance_requests, p_from public.maintenance_status, p_to public.maintenance_status, p_actor uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.maintenance_status_history (org_id, request_id, from_status, to_status, actor_id, note) values (p_req.org_id, p_req.id, p_from, p_to, p_actor, left(p_note, 1000)) returning id into v_id;
  if p_from is not null then
    perform app.notify_requester(p_req, 'maintenance.status', 'Request “' || p_req.title || '” is now ' || replace(p_to::text, '_', ' '), p_note, 'mr:' || p_req.id || ':status:' || v_id, p_actor);
  end if;
end $$;

-- Move a request to a lawful next status (the trigger re-checks) and record it.
create or replace function app.apply_status(p_request uuid, p_to public.maintenance_status, p_actor uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  select * into r from public.maintenance_requests where id = p_request for update;
  if r.status = p_to then return; end if;
  update public.maintenance_requests set status = p_to, triaged_at = case when p_to = 'triaged' then coalesce(triaged_at, now()) else triaged_at end, version = version + 1 where id = p_request;
  perform app.log_status(r, r.status, p_to, p_actor, p_note);
end $$;

-- ---------------------------------------------------------------- escalation
-- A request is critical if ANY of: its (human-set) urgency is critical, a safety keyword matches, or an advisory suggestion is critical.
-- Suggestions can only raise handling; nothing here ever lowers or clears escalation. A human must acknowledge it.
create or replace function app.evaluate_escalation(p_request uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests; u public.urgency_levels; su public.urgency_levels; s public.maintenance_settings;
  v_needed boolean; v_primary uuid; v_backup uuid; v_reason text; v_n int;
begin
  select * into r from public.maintenance_requests where id = p_request for update;
  if r.status in ('resolved', 'cancelled') then return false; end if;
  select * into u from public.urgency_levels where id = r.urgency_id;
  select * into su from public.urgency_levels where id = r.suggested_urgency_id;
  v_needed := u.is_critical or r.safety_flag or coalesce(su.is_critical, false);
  if not v_needed and not r.escalation_required then return false; end if;
  if not r.escalation_required then update public.maintenance_requests set escalation_required = true where id = p_request; end if;
  if r.escalated_at is not null then return false; end if;

  s := app.settings(r.org_id);
  v_primary := case when s.escalation_user_id is not null and app.role_rank(app.role_of_user(r.org_id, s.escalation_user_id)) >= app.role_rank('manager') then s.escalation_user_id end;
  v_backup := case when s.backup_user_id is not null and s.backup_user_id is distinct from v_primary
                    and app.role_rank(app.role_of_user(r.org_id, s.backup_user_id)) >= app.role_rank('manager') then s.backup_user_id end;
  v_reason := case when u.is_critical then 'urgency “' || u.label || '” is critical' when r.safety_flag then 'safety keyword “' || coalesce(app.keyword_hit(r.org_id, r.title || ' ' || r.description), '') || '” detected'
                   else 'a classification suggested a critical issue' end;
  update public.maintenance_requests set escalated_at = now(), escalated_to = v_primary, escalation_fallback = (v_primary is null) where id = p_request;
  perform app.system_note(r, 'ESCALATED as critical (' || v_reason || '). ' ||
    case when v_primary is not null then 'Sent to ' || app.actor_name(v_primary) || '.' else 'No designated contact is set, so every owner and admin was alerted.' end);
  if v_primary is not null then
    perform app.notify_user(r.org_id, v_primary, 'maintenance.escalated', 'CRITICAL: ' || r.title, v_reason || E'\n\n' || left(r.description, 500), '/app?org=' || r.org_id || '#/maintenance/' || r.id, 'mr:' || r.id || ':esc:0');
    if v_backup is not null then
      perform app.notify_user(r.org_id, v_backup, 'maintenance.escalated', 'CRITICAL: ' || r.title, v_reason || E'\n\n' || left(r.description, 500), '/app?org=' || r.org_id || '#/maintenance/' || r.id, 'mr:' || r.id || ':esc:0');
    end if;
  else
    v_n := app.notify_role(r.org_id, 'admin', 'maintenance.escalated', 'CRITICAL: ' || r.title, v_reason || E'\n\n' || left(r.description, 500), '/app?org=' || r.org_id || '#/maintenance/' || r.id, 'mr:' || r.id || ':esc:0');
  end if;
  return true;
end $$;

create or replace function public.acknowledge_escalation(p_org uuid, p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_request(p_org, p_request, true);
  if not r.escalation_required then raise exception 'this request was not escalated' using errcode = 'PT409'; end if;
  if r.escalation_ack_at is null then
    update public.maintenance_requests set escalation_ack_at = now(), escalation_ack_by = auth.uid(), version = version + 1 where id = p_request;
    perform app.system_note(r, 'Escalation acknowledged by ' || app.actor_name(auth.uid()) || '.');
  end if;
  return public.get_request(p_org, p_request);
end $$;

-- Advisory classification hook. It can only raise handling: the human-set urgency is never changed or overridden here.
create or replace function public.set_suggested_urgency(p_org uuid, p_request uuid, p_urgency uuid, p_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_request(p_org, p_request, true);
  if not exists (select 1 from public.urgency_levels where id = p_urgency and org_id = p_org) then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
  update public.maintenance_requests set suggested_urgency_id = p_urgency, suggestion_source = left(coalesce(nullif(btrim(p_source), ''), 'manual'), 60) where id = p_request;
  perform app.evaluate_escalation(p_request);
  return public.get_request(p_org, p_request);
end $$;

create or replace function public.change_urgency(p_org uuid, p_request uuid, p_expected_version int, p_urgency uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests; cur public.urgency_levels; nw public.urgency_levels;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_request(p_org, p_request, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status in ('resolved', 'cancelled') then raise exception 'a % request cannot change urgency', r.status using errcode = 'PT409'; end if;
  select * into cur from public.urgency_levels where id = r.urgency_id;
  select * into nw from public.urgency_levels where id = p_urgency and org_id = p_org and archived_at is null;
  if nw.id is null then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
  if nw.rank < cur.rank then
    perform app.require_role(p_org, 'manager');                      -- only managers may lower urgency, and must say why
    perform app.require_reason(p_reason);
    if r.escalation_required and r.escalation_ack_at is null then
      raise exception 'acknowledge the critical escalation before lowering the urgency' using errcode = 'PT409';
    end if;
  end if;
  update public.maintenance_requests set urgency_id = p_urgency, version = version + 1 where id = p_request;
  perform app.system_note(r, 'Urgency changed from “' || cur.label || '” to “' || nw.label || '” by ' || app.actor_name(auth.uid()) || coalesce(': ' || nullif(btrim(p_reason), ''), '.'));
  perform app.evaluate_escalation(p_request);
  return public.get_request(p_org, p_request);
end $$;

-- ------------------------------------------------------------ creating requests
create or replace function app.create_request(p_org uuid, p_property uuid, p_unit uuid, p_tenancy uuid, p_tenant uuid, p_via text, p_title text,
  p_description text, p_category public.maintenance_category, p_urgency uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_urg public.urgency_levels; v_id uuid; r public.maintenance_requests; v_hit text;
begin
  perform app.ensure_maintenance_defaults(p_org);
  if p_urgency is null then select * into v_urg from public.urgency_levels where org_id = p_org and is_default and archived_at is null;
  else select * into v_urg from public.urgency_levels where id = p_urgency and org_id = p_org and archived_at is null; end if;
  if v_urg.id is null then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
  if p_via = 'tenant' and not v_urg.tenant_selectable then raise exception 'that urgency level is not available to tenants' using errcode = 'PT422'; end if;
  v_hit := app.keyword_hit(p_org, btrim(p_title) || ' ' || btrim(p_description));
  insert into public.maintenance_requests (org_id, property_id, unit_id, tenancy_id, tenant_id, reported_by, reported_via, title, description, category, urgency_id, initial_urgency_id, safety_flag)
  values (p_org, p_property, p_unit, p_tenancy, p_tenant, auth.uid(), p_via, btrim(p_title), btrim(p_description), coalesce(p_category, 'other'), v_urg.id, v_urg.id, v_hit is not null)
  returning * into r;
  v_id := r.id;
  insert into public.maintenance_status_history (org_id, request_id, from_status, to_status, actor_id, note) values (p_org, v_id, null, 'submitted', auth.uid(), 'Request submitted');
  perform app.evaluate_escalation(v_id);
  perform app.notify_role(p_org, 'manager', 'maintenance.submitted', 'New maintenance request: ' || r.title, left(r.description, 500), '/app?org=' || p_org || '#/maintenance/' || v_id, 'mr:' || v_id || ':submitted', auth.uid());
  return v_id;
end $$;

create or replace function public.create_maintenance_request(p_org uuid, p_property uuid, p_unit uuid, p_tenancy uuid, p_title text, p_description text,
  p_category public.maintenance_category, p_urgency uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_tenant uuid;
begin
  perform app.require_role(p_org, 'staff');
  if (app.load_property(p_org, p_property)).archived_at is not null then raise exception 'property is archived' using errcode = 'PT409'; end if;
  if p_unit is not null and not exists (select 1 from public.units where id = p_unit and property_id = p_property and org_id = p_org) then
    raise exception 'unit does not belong to this property' using errcode = 'PT422';
  end if;
  if p_tenancy is not null then
    if p_unit is null or not exists (select 1 from public.tenancies where id = p_tenancy and unit_id = p_unit and org_id = p_org) then
      raise exception 'tenancy does not belong to this unit' using errcode = 'PT422';
    end if;
  end if;
  v_id := app.create_request(p_org, p_property, p_unit, p_tenancy, null, 'staff', p_title, p_description, p_category, p_urgency);
  return public.get_request(p_org, v_id);
end $$;

-- Tenant portal: only for a tenant verified for this organization, on an ACTIVE tenancy they are named on.
create or replace function public.portal_submit_request(p_org uuid, p_tenancy uuid, p_title text, p_description text, p_category public.maintenance_category, p_urgency uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := app.require_user(); v_tenant uuid; t public.tenancies; u public.units; v_id uuid;
begin
  select tt.tenant_id into v_tenant from public.tenancy_tenants tt join public.tenancies x on x.id = tt.tenancy_id
   where x.id = p_tenancy and x.org_id = p_org and x.status = 'active' and tt.tenant_id = any (app.tenant_ids_for(p_org)) limit 1;
  if v_tenant is null then raise exception 'you can only raise requests for your own active tenancy' using errcode = 'PT403'; end if;
  select * into t from public.tenancies where id = p_tenancy;
  select * into u from public.units where id = t.unit_id;
  v_id := app.create_request(p_org, u.property_id, t.unit_id, p_tenancy, v_tenant, 'tenant', p_title, p_description, p_category, p_urgency);
  return public.portal_get_request(p_org, v_id);
end $$;

-- --------------------------------------------------------------- lifecycle
create or replace function public.triage_request(p_org uuid, p_request uuid, p_expected_version int, p_category public.maintenance_category, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_request(p_org, p_request, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status <> 'submitted' then raise exception 'only submitted requests can be triaged' using errcode = 'PT409'; end if;
  if p_category is not null then update public.maintenance_requests set category = p_category where id = p_request; end if;
  perform app.apply_status(p_request, 'triaged', auth.uid(), p_note);
  return public.get_request(p_org, p_request);
end $$;

-- Return a request that lost its work to the right place.
create or replace function app.settle_request(p_request uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  select * into r from public.maintenance_requests where id = p_request;
  if r.status in ('resolved', 'cancelled', 'submitted', 'triaged') then return; end if;
  if exists (select 1 from public.work_orders where request_id = p_request and status in ('assigned', 'in_progress')) then return; end if;
  if r.status = 'in_progress' then perform app.apply_status(p_request, 'assigned', p_actor, 'No active work orders remain'); end if;
  perform app.apply_status(p_request, 'triaged', p_actor, 'No active work orders remain');
end $$;

create or replace function public.cancel_request(p_org uuid, p_request uuid, p_expected_version int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests; v_actor text := app.request_actor(p_org, p_request);
begin
  if v_actor is null then raise exception 'request not found' using errcode = 'PT404'; end if;
  r := app.load_request(p_org, p_request, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status in ('resolved', 'cancelled') then raise exception 'a % request cannot be cancelled', r.status using errcode = 'PT409'; end if;
  if v_actor = 'tenant' and r.status not in ('submitted', 'triaged') then raise exception 'work has already been arranged; contact your property manager to cancel' using errcode = 'PT403'; end if;
  if v_actor = 'staff' and r.status not in ('submitted', 'triaged') then perform app.require_role(p_org, 'manager'); end if;
  perform app.require_reason(p_reason);
  update public.work_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'request cancelled' where request_id = p_request and status in ('assigned', 'in_progress');
  perform app.invalidate_approvals(p_org, 'work_order', wo.id, 'request cancelled') from public.work_orders wo where wo.request_id = p_request;
  update public.maintenance_requests set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = btrim(p_reason), version = version + 1 where id = p_request;
  perform app.log_status(r, r.status, 'cancelled', auth.uid(), btrim(p_reason));
  return case when v_actor = 'tenant' then public.portal_get_request(p_org, p_request) else public.get_request(p_org, p_request) end;
end $$;

create or replace function public.resolve_request(p_org uuid, p_request uuid, p_expected_version int, p_resolution_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_request(p_org, p_request, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status <> 'in_progress' then raise exception 'only requests in progress can be resolved' using errcode = 'PT409'; end if;
  if exists (select 1 from public.work_orders where request_id = p_request and status in ('assigned', 'in_progress')) then
    raise exception 'complete or cancel the open work orders first' using errcode = 'PT409';
  end if;
  if p_resolution_notes is null or char_length(btrim(p_resolution_notes)) < 3 then raise exception 'resolution notes are required' using errcode = 'PT422'; end if;
  update public.maintenance_requests set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_notes = btrim(p_resolution_notes), version = version + 1 where id = p_request;
  perform app.log_status(r, r.status, 'resolved', auth.uid(), btrim(p_resolution_notes));
  perform app.system_note(r, 'Resolved: ' || btrim(p_resolution_notes), 'tenant');
  return public.get_request(p_org, p_request);
end $$;

create or replace function public.reopen_request(p_org uuid, p_request uuid, p_expected_version int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_request(p_org, p_request, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status <> 'resolved' then raise exception 'only resolved requests can be reopened' using errcode = 'PT409'; end if;
  update public.maintenance_requests set status = 'in_progress', resolved_at = null, resolved_by = null, resolution_notes = null, version = version + 1 where id = p_request;
  perform app.log_status(r, 'resolved', 'in_progress', auth.uid(), 'Reopened: ' || app.require_reason(p_reason));
  return public.get_request(p_org, p_request);
end $$;

-- -------------------------------------------------------------- work orders
create or replace function app.load_work_order(p_org uuid, p_id uuid, p_lock boolean default false) returns public.work_orders
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders;
begin
  if p_lock then select * into w from public.work_orders where id = p_id and org_id = p_org for update; else select * into w from public.work_orders where id = p_id and org_id = p_org; end if;
  if w.id is null then raise exception 'work order not found' using errcode = 'PT404'; end if;
  return w;
end $$;

-- Record an estimate. Replaces (and invalidates approvals of) any earlier one. At or under the org's threshold for the currency
-- it is approved automatically; otherwise a human approval is requested and the request waits in "awaiting approval".
create or replace function app.add_estimate(p_wo uuid, p_amount bigint, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders; r public.maintenance_requests; s public.maintenance_settings; v_est uuid; v_thr bigint; v_apr uuid;
begin
  select * into w from public.work_orders where id = p_wo for update;
  if w.status in ('completed', 'cancelled') then raise exception 'a % work order cannot take a new estimate', w.status using errcode = 'PT409'; end if;
  select * into r from public.maintenance_requests where id = w.request_id for update;
  update public.work_order_estimates set superseded_at = now() where work_order_id = p_wo and superseded_at is null;
  perform app.invalidate_approvals(w.org_id, 'work_order', p_wo, 'estimate replaced');
  insert into public.work_order_estimates (org_id, work_order_id, amount_minor, currency, description, submitted_by) values (w.org_id, p_wo, p_amount, w.currency, nullif(btrim(p_note), ''), auth.uid()) returning id into v_est;
  update public.work_orders set current_estimate_id = v_est, approved_cost_minor = null, approved_at = null, approved_by = null, version = version + 1 where id = p_wo;
  s := app.settings(w.org_id);
  v_thr := nullif(s.approval_thresholds ->> w.currency, '')::bigint;
  if v_thr is not null and p_amount <= v_thr then
    update public.work_orders set approved_cost_minor = p_amount, approved_at = now() where id = p_wo;
    perform app.system_note(r, 'Estimate of ' || p_amount || ' ' || w.currency || ' (minor units) is within the approval threshold and was approved automatically.');
    if r.status in ('triaged', 'awaiting_approval') then perform app.apply_status(r.id, 'assigned', auth.uid(), 'Estimate auto-approved'); end if;
  else
    v_apr := app.create_approval(w.org_id, 'maintenance.approve_cost', p_wo, jsonb_build_object('work_order_id', p_wo, 'estimate_id', v_est, 'amount_minor', p_amount, 'currency', w.currency, 'request_id', r.id), 'Estimate for “' || r.title || '”', 72);
    if r.status in ('triaged', 'assigned', 'in_progress') then perform app.apply_status(r.id, 'awaiting_approval', auth.uid(), 'Cost approval requested'); end if;
  end if;
  return v_est;
end $$;

create or replace function public.assign_work(p_org uuid, p_request uuid, p_vendor uuid, p_assignee uuid, p_scope text, p_estimate_minor bigint, p_estimate_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests; v_wo uuid; v_cur char(3); v_ven public.vendors; v_role public.org_role;
begin
  v_role := app.require_role(p_org, 'staff');
  r := app.load_request(p_org, p_request, true);
  if r.status not in ('submitted', 'triaged', 'awaiting_approval', 'assigned', 'in_progress') then raise exception 'work cannot be assigned on a % request', r.status using errcode = 'PT409'; end if;
  if num_nonnulls(p_vendor, p_assignee) <> 1 then raise exception 'assign the work to exactly one vendor or one staff member' using errcode = 'PT422'; end if;
  if p_assignee is not null then
    if app.role_rank(app.role_of_user(p_org, p_assignee)) < app.role_rank('staff') then raise exception 'only staff, managers, admins or owners can be assigned work' using errcode = 'PT422'; end if;
    if app.role_rank(v_role) < app.role_rank('manager') and p_assignee <> auth.uid() then raise exception 'staff can only assign work to themselves; ask a manager to assign it to someone else' using errcode = 'PT403'; end if;
  else
    select * into v_ven from public.vendors where id = p_vendor and org_id = p_org;
    if v_ven.id is null then raise exception 'vendor not found' using errcode = 'PT404'; end if;
    if v_ven.archived_at is not null then raise exception 'vendor is archived' using errcode = 'PT409'; end if;
  end if;
  if r.status = 'submitted' then perform app.apply_status(p_request, 'triaged', auth.uid(), 'Triaged on assignment'); end if;
  select currency into v_cur from public.properties where id = r.property_id;
  insert into public.work_orders (org_id, request_id, vendor_id, assignee_user_id, scope, currency, assigned_by) values (p_org, p_request, p_vendor, p_assignee, btrim(p_scope), v_cur, auth.uid()) returning id into v_wo;
  if p_estimate_minor is not null then perform app.add_estimate(v_wo, p_estimate_minor, p_estimate_note);
  elsif (select status from public.maintenance_requests where id = p_request) = 'triaged' then perform app.apply_status(p_request, 'assigned', auth.uid(), 'Work assigned'); end if;
  if p_assignee is not null then
    perform app.notify_user(p_org, p_assignee, 'maintenance.assigned', 'Work assigned to you: ' || r.title, left(p_scope, 500), '/app?org=' || p_org || '#/maintenance/' || p_request, 'wo:' || v_wo || ':assigned');
  else
    perform app.notify_email(p_org, v_ven.email, v_ven.name, 'maintenance.assigned', 'Work request: ' || r.title, left(p_scope, 1000), null, 'wo:' || v_wo || ':assigned');
  end if;
  return public.get_request(p_org, p_request);
end $$;

create or replace function public.submit_estimate(p_org uuid, p_work_order uuid, p_amount_minor bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders; v_role public.org_role;
begin
  v_role := app.require_role(p_org, 'staff');
  w := app.load_work_order(p_org, p_work_order, true);
  if w.assignee_user_id is distinct from auth.uid() and app.role_rank(v_role) < app.role_rank('manager') then
    raise exception 'only the assignee or a manager can submit an estimate' using errcode = 'PT403';
  end if;
  perform app.add_estimate(p_work_order, p_amount_minor, p_note);
  return public.get_request(p_org, w.request_id);
end $$;

create or replace function public.start_work(p_org uuid, p_work_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders; r public.maintenance_requests; v_role public.org_role;
begin
  v_role := app.require_role(p_org, 'staff');
  w := app.load_work_order(p_org, p_work_order, true);
  if w.assignee_user_id is distinct from auth.uid() and app.role_rank(v_role) < app.role_rank('manager') then raise exception 'only the assignee or a manager can start this work' using errcode = 'PT403'; end if;
  if w.status <> 'assigned' then raise exception 'only assigned work can be started' using errcode = 'PT409'; end if;
  if w.current_estimate_id is not null and w.approved_cost_minor is null then raise exception 'the estimated cost has not been approved yet' using errcode = 'PT409'; end if;
  r := app.load_request(p_org, w.request_id, true);
  if r.status not in ('assigned', 'in_progress') then raise exception 'the request is % and cannot start work', replace(r.status::text, '_', ' ') using errcode = 'PT409'; end if;
  update public.work_orders set status = 'in_progress', started_at = now(), version = version + 1 where id = p_work_order;
  if r.status = 'assigned' then perform app.apply_status(r.id, 'in_progress', auth.uid(), 'Work started'); end if;
  return public.get_request(p_org, w.request_id);
end $$;

create or replace function public.complete_work(p_org uuid, p_work_order uuid, p_actual_cost_minor bigint, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders; r public.maintenance_requests; v_role public.org_role;
begin
  v_role := app.require_role(p_org, 'staff');
  w := app.load_work_order(p_org, p_work_order, true);
  if w.assignee_user_id is distinct from auth.uid() and app.role_rank(v_role) < app.role_rank('manager') then raise exception 'only the assignee or a manager can complete this work' using errcode = 'PT403'; end if;
  if w.status <> 'in_progress' then raise exception 'only work in progress can be completed' using errcode = 'PT409'; end if;
  r := app.load_request(p_org, w.request_id);
  update public.work_orders set status = 'completed', completed_at = now(), actual_cost_minor = p_actual_cost_minor, completion_notes = nullif(btrim(p_notes), ''), version = version + 1 where id = p_work_order;
  if p_actual_cost_minor is not null and w.approved_cost_minor is not null and p_actual_cost_minor > w.approved_cost_minor then
    perform app.system_note(r, 'Actual cost (' || p_actual_cost_minor || ') exceeds the approved cost (' || w.approved_cost_minor || ') in ' || w.currency || ' minor units.');
    perform app.notify_role(p_org, 'manager', 'maintenance.status', 'Cost overrun on “' || r.title || '”', 'Actual cost exceeds the approved cost.', '/app?org=' || p_org || '#/maintenance/' || r.id, 'wo:' || p_work_order || ':overrun', auth.uid());
  end if;
  return public.get_request(p_org, w.request_id);
end $$;

create or replace function public.cancel_work_order(p_org uuid, p_work_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders;
begin
  perform app.require_role(p_org, 'manager');
  w := app.load_work_order(p_org, p_work_order, true);
  if w.status in ('completed', 'cancelled') then raise exception 'a % work order cannot be cancelled', w.status using errcode = 'PT409'; end if;
  update public.work_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = app.require_reason(p_reason), version = version + 1 where id = p_work_order;
  perform app.invalidate_approvals(p_org, 'work_order', p_work_order, 'work order cancelled');
  perform app.settle_request(w.request_id, auth.uid());
  return public.get_request(p_org, w.request_id);
end $$;

-- -------------------------------------------------------------------- notes
create or replace function public.add_request_note(p_org uuid, p_request uuid, p_body text, p_visibility public.note_visibility) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests; v_actor text := app.request_actor(p_org, p_request); v_vis public.note_visibility; v_id uuid;
begin
  if v_actor is null then raise exception 'request not found' using errcode = 'PT404'; end if;
  r := app.load_request(p_org, p_request);
  v_vis := case when v_actor = 'tenant' then 'tenant' else coalesce(p_visibility, 'internal') end;     -- tenants can only write tenant-visible notes
  insert into public.maintenance_notes (org_id, request_id, author_id, author_kind, visibility, body) values (p_org, p_request, auth.uid(), v_actor, v_vis, btrim(p_body)) returning id into v_id;
  if v_actor = 'staff' and v_vis = 'tenant' then
    perform app.notify_requester(r, 'maintenance.note', 'New message on “' || r.title || '”', left(p_body, 500), 'mn:' || v_id, auth.uid());
  elsif v_actor = 'tenant' then
    perform app.notify_role(p_org, 'manager', 'maintenance.note', 'Tenant message on “' || r.title || '”', left(p_body, 500), '/app?org=' || p_org || '#/maintenance/' || r.id, 'mn:' || v_id, null);
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- -------------------------------------------------------------- attachments
create or replace function public.create_maintenance_attachment(p_org uuid, p_request uuid, p_file_name text, p_mime_type text, p_size_bytes bigint, p_visibility public.note_visibility) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests; v_actor text := app.request_actor(p_org, p_request); v_id uuid := gen_random_uuid(); v_name text; a public.maintenance_attachments;
begin
  if v_actor is null then raise exception 'request not found' using errcode = 'PT404'; end if;
  r := app.load_request(p_org, p_request);
  if r.status in ('resolved', 'cancelled') and v_actor = 'tenant' then raise exception 'this request is closed' using errcode = 'PT409'; end if;
  if p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then raise exception 'file type not allowed (PDF, PNG, JPEG or WebP)' using errcode = 'PT422'; end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then raise exception 'file must be between 1 byte and 10 MB' using errcode = 'PT422'; end if;
  if (select count(*) from public.maintenance_attachments where request_id = p_request and archived_at is null) >= 25 then raise exception 'a request can hold at most 25 attachments' using errcode = 'PT409'; end if;
  v_name := coalesce(nullif(regexp_replace(left(btrim(p_file_name), 120), '[^A-Za-z0-9._-]+', '_', 'g'), ''), 'file');
  insert into public.maintenance_attachments (id, org_id, request_id, file_name, mime_type, size_bytes, storage_path, uploaded_by, uploader_kind, visibility)
  values (v_id, p_org, p_request, left(btrim(p_file_name), 200), p_mime_type, p_size_bytes, p_org || '/' || p_request || '/' || v_id || '-' || v_name, auth.uid(), v_actor,
          case when v_actor = 'tenant' then 'tenant' else coalesce(p_visibility, 'internal') end) returning * into a;
  return to_jsonb(a);
end $$;

create or replace function public.get_pending_attachment(p_org uuid, p_attachment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.maintenance_attachments;
begin
  select * into a from public.maintenance_attachments where id = p_attachment and org_id = p_org and status = 'pending' and uploaded_by = auth.uid();
  if a.id is null then raise exception 'attachment not found' using errcode = 'PT404'; end if;
  return to_jsonb(a);
end $$;

create or replace function public.confirm_maintenance_attachment(p_org uuid, p_attachment uuid, p_size_bytes bigint, p_mime_type text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.maintenance_attachments;
begin
  select * into a from public.maintenance_attachments where id = p_attachment and org_id = p_org and uploaded_by = auth.uid() for update;
  if a.id is null then raise exception 'attachment not found' using errcode = 'PT404'; end if;
  if a.status <> 'pending' then raise exception 'attachment already confirmed' using errcode = 'PT409'; end if;
  if p_size_bytes < 1 or p_size_bytes > 10485760 then raise exception 'file must be between 1 byte and 10 MB' using errcode = 'PT422'; end if;
  update public.maintenance_attachments set status = 'available', size_bytes = p_size_bytes, mime_type = p_mime_type where id = p_attachment returning * into a;
  return to_jsonb(a) - 'storage_path';
end $$;

create or replace function public.get_attachment_access(p_org uuid, p_attachment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.maintenance_attachments; v_actor text;
begin
  select * into a from public.maintenance_attachments where id = p_attachment and org_id = p_org and status = 'available' and archived_at is null;
  if a.id is null then raise exception 'attachment not found' using errcode = 'PT404'; end if;
  v_actor := app.request_actor(p_org, a.request_id);
  if v_actor is null or (v_actor = 'tenant' and a.visibility <> 'tenant') then raise exception 'attachment not found' using errcode = 'PT404'; end if;
  return to_jsonb(a);
end $$;

create or replace function public.archive_attachment(p_org uuid, p_attachment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.maintenance_attachments;
begin
  select * into a from public.maintenance_attachments where id = p_attachment and org_id = p_org for update;
  if a.id is null or app.request_actor(p_org, a.request_id) is distinct from 'staff' then raise exception 'attachment not found' using errcode = 'PT404'; end if;
  if a.uploaded_by <> auth.uid() then perform app.require_role(p_org, 'manager'); end if;
  update public.maintenance_attachments set archived_at = now() where id = p_attachment returning * into a;
  return to_jsonb(a) - 'storage_path';
end $$;

-- -------------------------------------------------------------------- reads
create or replace function app.attachments_json(p_request uuid, p_tenant_view boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'visibility', a.visibility,
    'uploader_kind', a.uploader_kind, 'uploaded_by', app.actor_name(a.uploaded_by), 'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
  from public.maintenance_attachments a where a.request_id = p_request and a.status = 'available' and a.archived_at is null and (not p_tenant_view or a.visibility = 'tenant') $$;

create or replace function public.get_request(p_org uuid, p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_request(p_org, p_request);
  return to_jsonb(r) || jsonb_build_object(
    'urgency', (select jsonb_build_object('id', u.id, 'label', u.label, 'rank', u.rank, 'is_critical', u.is_critical) from public.urgency_levels u where u.id = r.urgency_id),
    'suggested_urgency', (select jsonb_build_object('id', u.id, 'label', u.label, 'is_critical', u.is_critical) from public.urgency_levels u where u.id = r.suggested_urgency_id),
    'property', (select jsonb_build_object('id', p.id, 'name', p.name, 'currency', p.currency, 'timezone', p.timezone) from public.properties p where p.id = r.property_id),
    'unit', (select jsonb_build_object('id', u.id, 'reference', u.reference) from public.units u where u.id = r.unit_id),
    'tenant', (select jsonb_build_object('id', t.id, 'full_name', t.full_name, 'email', t.email, 'phone', t.phone) from public.tenants t where t.id = r.tenant_id),
    'reporter', app.actor_name(r.reported_by),
    'escalated_to_name', app.actor_name(r.escalated_to),
    'escalation_ack_by_name', app.actor_name(r.escalation_ack_by),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'from_status', h.from_status, 'to_status', h.to_status, 'actor', app.actor_name(h.actor_id), 'note', h.note, 'created_at', h.created_at) order by h.id)
                           from public.maintenance_status_history h where h.request_id = r.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'visibility', n.visibility, 'author_kind', n.author_kind, 'author', app.actor_name(n.author_id), 'created_at', n.created_at) order by n.created_at)
                         from public.maintenance_notes n where n.request_id = r.id), '[]'::jsonb),
    'work_orders', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'status', w.status, 'scope', w.scope, 'currency', w.currency,
        'vendor', (select jsonb_build_object('id', v.id, 'name', v.name) from public.vendors v where v.id = w.vendor_id),
        'assignee', app.actor_name(w.assignee_user_id), 'assignee_user_id', w.assignee_user_id,
        'current_estimate', (select jsonb_build_object('id', e.id, 'amount_minor', e.amount_minor, 'description', e.description, 'created_at', e.created_at) from public.work_order_estimates e where e.id = w.current_estimate_id),
        'estimates', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'amount_minor', e.amount_minor, 'created_at', e.created_at, 'superseded', e.superseded_at is not null) order by e.created_at)
                                from public.work_order_estimates e where e.work_order_id = w.id), '[]'::jsonb),
        'approved_cost_minor', w.approved_cost_minor, 'approved_at', w.approved_at, 'actual_cost_minor', w.actual_cost_minor, 'completion_notes', w.completion_notes,
        'started_at', w.started_at, 'completed_at', w.completed_at, 'cancel_reason', w.cancel_reason, 'version', w.version,
        'approval', (select jsonb_build_object('id', a.id, 'status', a.status) from public.approvals a where a.target_id = w.id and a.action_type = 'maintenance.approve_cost' order by a.requested_at desc limit 1)) order by w.created_at)
                         from public.work_orders w where w.request_id = r.id), '[]'::jsonb),
    'attachments', app.attachments_json(r.id, false));
end $$;

create or replace function public.list_requests(p_org uuid, p_status public.maintenance_status default null, p_urgency uuid default null, p_property uuid default null,
  p_category public.maintenance_category default null, p_assignee uuid default null, p_attention boolean default false, p_search text default null,
  p_sort text default 'created', p_dir text default 'desc', p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'staff');
  v_col := case p_sort when 'created' then 'created_at' when 'updated' then 'updated_at' when 'urgency' then 'urgency_rank' when 'status' then 'status' when 'property' then 'property_name' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  execute format($q$
    with filtered as (
      select r.id, r.title, r.status, r.category, r.created_at, r.updated_at, r.property_id, r.unit_id, r.escalation_required, r.escalated_at, r.escalation_ack_at, r.reported_via,
             u.label as urgency_label, u.rank as urgency_rank, u.is_critical as urgency_critical, pr.name as property_name, un.reference as unit_reference,
             (select count(*) from public.work_orders w where w.request_id = r.id and w.status in ('assigned', 'in_progress')) as open_work_orders,
             (select count(*) from public.approvals a join public.work_orders w on w.id = a.target_id where w.request_id = r.id and a.status = 'pending') as pending_approvals
      from public.maintenance_requests r join public.urgency_levels u on u.id = r.urgency_id join public.properties pr on pr.id = r.property_id left join public.units un on un.id = r.unit_id
      where r.org_id = $1 and ($2::public.maintenance_status is null or r.status = $2) and ($3::uuid is null or r.urgency_id = $3) and ($4::uuid is null or r.property_id = $4)
        and ($5::public.maintenance_category is null or r.category = $5)
        and ($6::uuid is null or exists (select 1 from public.work_orders w where w.request_id = r.id and w.assignee_user_id = $6 and w.status in ('assigned', 'in_progress')))
        and (not $7 or (r.escalation_required and r.escalation_ack_at is null and r.status not in ('resolved', 'cancelled')))
        and ($8::text is null or r.title ilike $8 or r.description ilike $8 or pr.name ilike $8 or un.reference ilike $8))
    select jsonb_build_object('total', (select count(*) from filtered),
      'attention', (select count(*) from filtered where escalation_required and escalation_ack_at is null and status not in ('resolved', 'cancelled')),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $9 offset $10) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_status, p_urgency, p_property, p_category, p_assignee, coalesce(p_attention, false), app.like_pattern(p_search), app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

-- ----------------------------------------------------------- portal reads
create or replace function public.portal_list_requests() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := app.require_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'org_id', r.org_id, 'title', r.title, 'status', r.status, 'category', r.category, 'created_at', r.created_at, 'updated_at', r.updated_at,
      'unit_reference', un.reference, 'property_name', pr.name, 'urgency_label', u.label) order by r.created_at desc)
    from public.maintenance_requests r join public.tenant_users tu on tu.org_id = r.org_id and tu.tenant_id = r.tenant_id and tu.user_id = uid and tu.revoked_at is null
      join public.properties pr on pr.id = r.property_id left join public.units un on un.id = r.unit_id join public.urgency_levels u on u.id = r.urgency_id), '[]'::jsonb);
end $$;

create or replace function public.portal_get_request(p_org uuid, p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  if app.request_actor(p_org, p_request) is distinct from 'tenant' then raise exception 'request not found' using errcode = 'PT404'; end if;
  r := app.load_request(p_org, p_request);
  return jsonb_build_object('id', r.id, 'org_id', r.org_id, 'title', r.title, 'description', r.description, 'status', r.status, 'category', r.category, 'created_at', r.created_at,
    'resolution_notes', r.resolution_notes, 'cancel_reason', r.cancel_reason,
    'urgency_label', (select label from public.urgency_levels where id = r.urgency_id),
    'property_name', (select name from public.properties where id = r.property_id), 'unit_reference', (select reference from public.units where id = r.unit_id),
    'can_cancel', r.status in ('submitted', 'triaged'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('to_status', h.to_status, 'created_at', h.created_at) order by h.id) from public.maintenance_status_history h where h.request_id = r.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('body', n.body, 'author_kind', n.author_kind, 'created_at', n.created_at) order by n.created_at)
                         from public.maintenance_notes n where n.request_id = r.id and n.visibility = 'tenant'), '[]'::jsonb),
    'attachments', app.attachments_json(r.id, true));
end $$;
