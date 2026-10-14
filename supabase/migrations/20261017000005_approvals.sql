-- Reusable approval engine.
-- A proposal is immutable (payload + hash + a fingerprint of the target's state). Deciding requires a different, sufficiently
-- senior human. Executing re-checks: both people's roles, the target's access, and that nothing about the target has changed.

create table if not exists public.approval_events (
  id          bigint generated always as identity primary key,
  org_id      uuid not null,
  approval_id uuid not null,
  from_status public.approval_status,
  to_status   public.approval_status not null,
  actor_id    uuid references auth.users (id),            -- null = system (expiry job, invalidation)
  note        text check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete restrict
);
create index if not exists approval_events_idx on public.approval_events (approval_id, id);
drop trigger if exists approval_events_guard on public.approval_events;
create trigger approval_events_guard before update or delete on public.approval_events for each row execute function app.finance_guard();
revoke all on public.approval_events from anon, authenticated;
grant select on public.approval_events to authenticated;
alter table public.approval_events enable row level security;
drop policy if exists approval_events_select on public.approval_events;
create policy approval_events_select on public.approval_events for select to authenticated
  using (app.has_role(org_id, 'manager') or exists (select 1 from public.approvals a where a.id = approval_id and a.requested_by = (select auth.uid())));

create or replace function app.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- Hash of the parts of the target that, if changed, make a previously proposed action stale. NULL = target not found in this org.
create or replace function app.approval_fingerprint(p_org uuid, p_action text, p_target uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if p_action = 'maintenance.approve_cost' then
    -- The request's own status is deliberately NOT part of this: it moves to "awaiting approval" as a consequence of proposing.
    select app.sha256_hex(concat_ws('|', w.id, w.status, coalesce(w.current_estimate_id::text, ''), coalesce(w.approved_cost_minor::text, ''), r.id,
             coalesce((select e.amount_minor::text from public.work_order_estimates e where e.id = w.current_estimate_id), '')))
      into v from public.work_orders w join public.maintenance_requests r on r.id = w.request_id and r.org_id = w.org_id where w.id = p_target and w.org_id = p_org;
  elsif p_action = 'finance.void_charge' then
    select app.sha256_hex(concat_ws('|', c.id, c.amount_minor, coalesce(c.voided_at::text, ''),
             (select coalesce(sum(a.amount_minor), 0) from public.charge_adjustments a where a.charge_id = c.id),
             (select count(*) from public.payment_allocations a where a.charge_id = c.id and a.reversed_at is null)))
      into v from public.charges c where c.id = p_target and c.org_id = p_org;
  end if;
  return v;
end $$;

create or replace function app.approval_log(p_approval uuid, p_from public.approval_status, p_to public.approval_status, p_actor uuid, p_note text) returns void
language sql security definer set search_path = '' as $$
  insert into public.approval_events (org_id, approval_id, from_status, to_status, actor_id, note)
  select org_id, id, p_from, p_to, p_actor, left(p_note, 500) from public.approvals where id = p_approval $$;

-- Move to a new status (the trigger enforces the lifecycle) and log it.
create or replace function app.approval_set(p_id uuid, p_to public.approval_status, p_actor uuid, p_note text, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.approvals;
begin
  select * into a from public.approvals where id = p_id for update;
  update public.approvals set status = p_to,
    decided_by = case when p_to in ('approved', 'rejected') then p_actor else decided_by end,
    decided_at = case when p_to in ('approved', 'rejected') then now() else decided_at end,
    decision_note = case when p_to in ('approved', 'rejected', 'cancelled', 'invalidated') then coalesce(left(p_note, 1000), decision_note) else decision_note end,
    execution_error = case when p_to in ('failed', 'invalidated') then left(coalesce(p_error, p_note), 500) else execution_error end
  where id = p_id;
  perform app.approval_log(p_id, a.status, p_to, p_actor, p_note);
end $$;

create or replace function app.approvers_notify(p_a public.approvals, p_event text, p_title text, p_body text, p_dedupe text) returns void
language plpgsql security definer set search_path = '' as $$
declare act public.approval_actions; s public.maintenance_settings;
begin
  select * into act from public.approval_actions where action_type = p_a.action_type;
  s := app.settings(p_a.org_id);
  perform app.notify_role(p_a.org_id, act.approve_min_role, p_event, p_title, p_body, '/app?org=' || p_a.org_id || '#/approvals/' || p_a.id, p_dedupe,
    case when s.allow_self_approval then null else p_a.requested_by end);
end $$;

-- Withdraw every live approval for a target because the target changed or went away.
create or replace function app.invalidate_approvals(p_org uuid, p_target_type text, p_target uuid, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare a public.approvals; v_n int := 0;
begin
  for a in select * from public.approvals where org_id = p_org and target_type = p_target_type and target_id = p_target and status in ('pending', 'approved', 'failed') for update loop
    perform app.approval_set(a.id, 'invalidated', null, p_reason, p_reason);
    perform app.notify_user(p_org, a.requested_by, 'approval.decided', 'Approval withdrawn: ' || (select label from public.approval_actions where action_type = a.action_type), p_reason,
      '/app?org=' || p_org || '#/approvals/' || a.id, 'ap:' || a.id || ':invalidated');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- The proposed payload must match what the system itself would propose; callers cannot forge arbitrary payloads.
create or replace function app.validate_approval_payload(p_org uuid, p_action text, p_target uuid, p_payload jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare w public.work_orders; v_est public.work_order_estimates;
begin
  if p_action = 'maintenance.approve_cost' then
    select * into w from public.work_orders where id = p_target and org_id = p_org;
    if w.id is null or w.current_estimate_id is null then raise exception 'there is no estimate to approve' using errcode = 'PT422'; end if;
    select * into v_est from public.work_order_estimates where id = w.current_estimate_id;
    if p_payload is distinct from jsonb_build_object('work_order_id', w.id, 'estimate_id', v_est.id, 'amount_minor', v_est.amount_minor, 'currency', w.currency, 'request_id', w.request_id) then
      raise exception 'the proposed payload does not match the current estimate' using errcode = 'PT422';
    end if;
  elsif p_action = 'finance.void_charge' then
    if p_payload is null or (p_payload ->> 'charge_id') is distinct from p_target::text or char_length(btrim(coalesce(p_payload ->> 'reason', ''))) < 3
       or (select count(*) from jsonb_object_keys(p_payload)) <> 2 then
      raise exception 'payload must be {"charge_id": <target>, "reason": <text>}' using errcode = 'PT422';
    end if;
  end if;
end $$;

create or replace function app.create_approval(p_org uuid, p_action text, p_target uuid, p_payload jsonb, p_note text, p_expires_hours int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare act public.approval_actions; v_fp text; v_hash text; v_existing public.approvals; v_id uuid; a public.approvals; v_type text; v_role public.org_role;
begin
  select * into act from public.approval_actions where action_type = p_action;
  if act.action_type is null then raise exception 'unsupported approval action' using errcode = 'PT422'; end if;
  v_role := app.role_of_user(p_org, auth.uid());
  if v_role is null or app.role_rank(v_role) < app.role_rank(act.request_min_role) then raise exception 'your role cannot request this approval' using errcode = 'PT403'; end if;
  v_type := case p_action when 'maintenance.approve_cost' then 'work_order' when 'finance.void_charge' then 'charge' end;
  v_fp := app.approval_fingerprint(p_org, p_action, p_target);
  if v_fp is null then raise exception 'target not found' using errcode = 'PT404'; end if;
  perform app.validate_approval_payload(p_org, p_action, p_target, p_payload);
  v_hash := app.sha256_hex(p_payload::text);
  -- Serialise proposals per target, then look for a live one BEFORE inserting. (The unique index would also stop duplicates,
  -- but it would turn a harmless repeat request into an error for the losers of a race.)
  perform pg_advisory_xact_lock(hashtextextended('approval:' || p_org || ':' || p_action || ':' || p_target, 0));
  select * into v_existing from public.approvals where org_id = p_org and action_type = p_action and target_id = p_target and status in ('pending', 'approved', 'executing') for update;
  if v_existing.id is not null then
    if v_existing.payload_hash = v_hash and v_existing.target_fingerprint = v_fp then return v_existing.id; end if;     -- same proposal: idempotent
    if v_existing.status = 'executing' then raise exception 'this approval is being executed right now' using errcode = 'PT409'; end if;
    perform app.approval_set(v_existing.id, 'invalidated', auth.uid(), 'superseded by a changed proposal', 'superseded by a changed proposal');
  end if;
  insert into public.approvals (org_id, action_type, requested_by, request_note, target_type, target_id, payload, payload_hash, target_fingerprint, expires_at)
  values (p_org, p_action, auth.uid(), nullif(btrim(p_note), ''), v_type, p_target, p_payload, v_hash, v_fp, now() + make_interval(hours => greatest(1, least(coalesce(p_expires_hours, 72), 720)))) returning * into a;
  perform app.approval_log(a.id, null, 'pending', auth.uid(), 'requested');
  perform app.approvers_notify(a, 'approval.requested', 'Approval needed: ' || act.label, coalesce(a.request_note, act.description), 'ap:' || a.id || ':requested');
  return a.id;
end $$;

create or replace function public.request_approval(p_org uuid, p_action text, p_target uuid, p_payload jsonb, p_note text, p_expires_in_hours int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require_role(p_org, 'staff');
  v_id := app.create_approval(p_org, p_action, p_target, p_payload, p_note, p_expires_in_hours);
  return public.get_approval(p_org, v_id);
end $$;

-- ---------------------------------------------------------------- executors
create or replace function app.exec_maintenance_approve_cost(a public.approvals) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.work_orders; r public.maintenance_requests; v_amount bigint := (a.payload ->> 'amount_minor')::bigint;
begin
  select * into w from public.work_orders where id = a.target_id and org_id = a.org_id for update;
  if w.id is null then raise exception 'work order not found' using errcode = 'AP001'; end if;
  if w.status in ('completed', 'cancelled') then raise exception 'the work order is %', w.status using errcode = 'AP001'; end if;
  if w.current_estimate_id is distinct from (a.payload ->> 'estimate_id')::uuid then raise exception 'the estimate has been replaced' using errcode = 'AP001'; end if;
  select * into r from public.maintenance_requests where id = w.request_id for update;
  update public.work_orders set approved_cost_minor = v_amount, approved_at = now(), approved_by = a.decided_by, version = version + 1 where id = w.id;
  if r.status = 'awaiting_approval' and not exists (
       select 1 from public.approvals x join public.work_orders y on y.id = x.target_id
        where y.request_id = r.id and x.id <> a.id and x.action_type = 'maintenance.approve_cost' and x.status in ('pending', 'approved', 'executing')) then
    perform app.apply_status(r.id, 'assigned', a.decided_by, 'Cost approved');
  end if;
  perform app.system_note(r, 'Cost of ' || app.money_text(v_amount, w.currency) || ' approved by ' || app.actor_name(a.decided_by) || '.');
  if w.assignee_user_id is not null then
    perform app.notify_user(a.org_id, w.assignee_user_id, 'maintenance.status', 'Cost approved: ' || r.title, 'You can start the work.', '/app?org=' || a.org_id || '#/maintenance/' || r.id, a.execution_key || ':assignee');
  end if;
  return jsonb_build_object('work_order_id', w.id, 'approved_cost_minor', v_amount, 'currency', w.currency);
end $$;

create or replace function app.exec_finance_void_charge(a public.approvals) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.charges; v_before jsonb;
begin
  select * into c from public.charges where id = a.target_id and org_id = a.org_id for update;
  if c.id is null then raise exception 'charge not found' using errcode = 'AP001'; end if;
  if c.voided_at is not null then return jsonb_build_object('charge_id', c.id, 'already_void', true); end if;
  if exists (select 1 from public.payment_allocations where charge_id = c.id and reversed_at is null) then raise exception 'the charge has payments applied; reverse them first' using errcode = 'AP001'; end if;
  v_before := app.charge_json(a.org_id, c.id);
  update public.charges set voided_at = now(), voided_by = a.decided_by, void_reason = left(btrim(a.payload ->> 'reason') || ' (approval ' || a.id || ')', 500) where id = c.id;
  perform app.audit(a.org_id, 'charge.voided', 'charge', c.id, v_before, app.charge_json(a.org_id, c.id), 'approved: ' || (a.payload ->> 'reason'));
  return jsonb_build_object('charge_id', c.id, 'already_void', false);
end $$;

-- Run an approved action. Can be retried while it is `failed`.
create or replace function app.run_approval(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.approvals; act public.approval_actions; v_result jsonb; v_msg text; v_state text; v_req public.org_role; v_apr public.org_role; v_fp text;
begin
  select * into a from public.approvals where id = p_id for update;
  if a.status = 'executed' then return jsonb_build_object('ok', true, 'status', 'executed', 'result', a.execution_result); end if;
  if a.status not in ('approved', 'failed') then return jsonb_build_object('ok', false, 'status', a.status, 'message', 'only approved actions can be executed'); end if;
  if a.expires_at <= now() then
    perform app.approval_set(p_id, 'expired', null, 'expired before execution');
    return jsonb_build_object('ok', false, 'status', 'expired', 'message', 'the approval expired before it was executed');
  end if;
  select * into act from public.approval_actions where action_type = a.action_type;
  update public.approvals set execution_started = now(), execution_attempts = execution_attempts + 1 where id = p_id;
  perform app.approval_set(p_id, 'executing', auth.uid(), 'executing');
  begin
    -- Permissions and target access are checked NOW, not at request time.
    v_req := app.role_of_user(a.org_id, a.requested_by);
    v_apr := app.role_of_user(a.org_id, a.decided_by);
    if v_req is null or app.role_rank(v_req) < app.role_rank(act.request_min_role) then raise exception 'the requester no longer has permission to propose this action' using errcode = 'AP002'; end if;
    if v_apr is null or app.role_rank(v_apr) < app.role_rank(act.approve_min_role) then raise exception 'the approver no longer has permission to authorize this action' using errcode = 'AP002'; end if;
    v_fp := app.approval_fingerprint(a.org_id, a.action_type, a.target_id);
    if v_fp is null then raise exception 'the target is no longer accessible' using errcode = 'AP001'; end if;
    if v_fp <> a.target_fingerprint then raise exception 'the target changed after the action was proposed' using errcode = 'AP001'; end if;
    if a.payload_hash <> app.sha256_hex(a.payload::text) then raise exception 'the proposal was altered' using errcode = 'AP001'; end if;
    v_result := case a.action_type when 'maintenance.approve_cost' then app.exec_maintenance_approve_cost(a) when 'finance.void_charge' then app.exec_finance_void_charge(a) end;
    update public.approvals set executed_at = now(), execution_result = v_result, execution_error = null where id = p_id;
    perform app.approval_set(p_id, 'executed', auth.uid(), 'executed');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_state = 'AP001' then perform app.approval_set(p_id, 'invalidated', auth.uid(), v_msg, v_msg);
    else perform app.approval_set(p_id, 'failed', auth.uid(), v_msg, v_msg); end if;
    perform app.notify_user(a.org_id, a.requested_by, 'approval.decided', 'Approval could not be completed: ' || act.label, v_msg, '/app?org=' || a.org_id || '#/approvals/' || a.id, 'ap:' || a.id || ':exec_failed:' || a.execution_attempts);
    return jsonb_build_object('ok', false, 'status', case when v_state = 'AP001' then 'invalidated' else 'failed' end, 'message', v_msg);
  end;
  perform app.notify_user(a.org_id, a.requested_by, 'approval.decided', 'Approved and done: ' || act.label, coalesce(a.decision_note, 'The action was carried out.'), '/app?org=' || a.org_id || '#/approvals/' || a.id, 'ap:' || a.id || ':executed');
  return jsonb_build_object('ok', true, 'status', 'executed', 'result', v_result);
end $$;

-- ------------------------------------------------------------------ public API
create or replace function public.decide_approval(p_org uuid, p_approval uuid, p_decision text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.approvals; act public.approval_actions; s public.maintenance_settings; v_role public.org_role; v_out jsonb := '{}'::jsonb;
begin
  perform app.require_role(p_org, 'staff');
  select * into a from public.approvals where id = p_approval and org_id = p_org for update;
  if a.id is null then raise exception 'approval not found' using errcode = 'PT404'; end if;
  select * into act from public.approval_actions where action_type = a.action_type;
  v_role := app.my_role(p_org);
  if app.role_rank(v_role) < app.role_rank(act.approve_min_role) then raise exception 'your role cannot decide this approval' using errcode = 'PT403'; end if;
  s := app.settings(p_org);
  if a.requested_by = auth.uid() and not s.allow_self_approval then raise exception 'you cannot approve your own request' using errcode = 'PT403'; end if;
  if p_decision not in ('approve', 'reject') then raise exception 'decision must be approve or reject' using errcode = 'PT422'; end if;
  -- Repeating the same decision is harmless.
  if p_decision = 'approve' and a.status in ('approved', 'executing', 'executed') then return jsonb_build_object('ok', true, 'replayed', true, 'approval', public.get_approval(p_org, p_approval)); end if;
  if p_decision = 'reject' and a.status = 'rejected' then return jsonb_build_object('ok', true, 'replayed', true, 'approval', public.get_approval(p_org, p_approval)); end if;
  if a.status <> 'pending' then raise exception 'this approval is % and can no longer be decided', a.status using errcode = 'PT409'; end if;
  if a.expires_at <= now() then raise exception 'this approval has expired' using errcode = 'PT409'; end if;
  if p_decision = 'reject' then
    perform app.approval_set(p_approval, 'rejected', auth.uid(), coalesce(nullif(btrim(p_note), ''), 'rejected'));
    -- A refused cost sends the request back to triage so someone revises the plan; it must not sit "awaiting approval" forever.
    if a.action_type = 'maintenance.approve_cost' then
      perform app.settle_after_rejection((a.payload ->> 'request_id')::uuid, auth.uid(), coalesce(nullif(btrim(p_note), ''), 'cost rejected'));
    end if;
    perform app.notify_user(p_org, a.requested_by, 'approval.decided', 'Rejected: ' || act.label, p_note, '/app?org=' || p_org || '#/approvals/' || p_approval, 'ap:' || p_approval || ':rejected');
    return jsonb_build_object('ok', true, 'approval', public.get_approval(p_org, p_approval));
  end if;
  -- A changed target must not be approved on the strength of an old proposal.
  if app.approval_fingerprint(p_org, a.action_type, a.target_id) is distinct from a.target_fingerprint then
    perform app.approval_set(p_approval, 'invalidated', auth.uid(), 'the target changed after the action was proposed', 'the target changed after the action was proposed');
    return jsonb_build_object('ok', false, 'status', 'invalidated', 'message', 'The record changed after this was proposed, so it can no longer be approved. Ask for a fresh approval.', 'approval', public.get_approval(p_org, p_approval));
  end if;
  perform app.approval_set(p_approval, 'approved', auth.uid(), nullif(btrim(p_note), ''));
  v_out := app.run_approval(p_approval);
  return v_out || jsonb_build_object('approval', public.get_approval(p_org, p_approval));
end $$;

-- Retry a failed execution (approvers only; the approval stays tied to the original decision).
create or replace function public.retry_approval(p_org uuid, p_approval uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.approvals; act public.approval_actions; v_out jsonb;
begin
  perform app.require_role(p_org, 'staff');
  select * into a from public.approvals where id = p_approval and org_id = p_org for update;
  if a.id is null then raise exception 'approval not found' using errcode = 'PT404'; end if;
  select * into act from public.approval_actions where action_type = a.action_type;
  if app.role_rank(app.my_role(p_org)) < app.role_rank(act.approve_min_role) then raise exception 'your role cannot execute this approval' using errcode = 'PT403'; end if;
  if a.status = 'executed' then return jsonb_build_object('ok', true, 'replayed', true, 'approval', public.get_approval(p_org, p_approval)); end if;
  if a.status not in ('approved', 'failed') then raise exception 'only approved or failed actions can be executed' using errcode = 'PT409'; end if;
  v_out := app.run_approval(p_approval);
  return v_out || jsonb_build_object('approval', public.get_approval(p_org, p_approval));
end $$;

create or replace function public.cancel_approval(p_org uuid, p_approval uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.approvals;
begin
  perform app.require_role(p_org, 'staff');
  select * into a from public.approvals where id = p_approval and org_id = p_org for update;
  if a.id is null then raise exception 'approval not found' using errcode = 'PT404'; end if;
  if a.requested_by <> auth.uid() and not app.has_role(p_org, 'manager') then raise exception 'approval not found' using errcode = 'PT404'; end if;
  if a.status = 'cancelled' then return public.get_approval(p_org, p_approval); end if;
  if a.status not in ('pending', 'approved', 'failed') then raise exception 'a % approval cannot be cancelled', a.status using errcode = 'PT409'; end if;
  perform app.approval_set(p_approval, 'cancelled', auth.uid(), coalesce(nullif(btrim(p_note), ''), 'cancelled'));
  return public.get_approval(p_org, p_approval);
end $$;

create or replace function app.approval_json(a public.approvals, p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare act public.approval_actions; s public.maintenance_settings; v_role public.org_role := app.role_of_user(a.org_id, p_viewer); v_eff public.approval_status := a.status;
begin
  select * into act from public.approval_actions where action_type = a.action_type;
  select * into s from public.maintenance_settings where org_id = a.org_id;
  if a.status in ('pending', 'approved') and a.expires_at <= now() then v_eff := 'expired'; end if;
  return jsonb_build_object('id', a.id, 'action_type', a.action_type, 'action_label', act.label, 'description', act.description, 'status', v_eff, 'stored_status', a.status,
    'requested_by', app.actor_name(a.requested_by), 'requested_by_id', a.requested_by, 'requested_at', a.requested_at, 'request_note', a.request_note,
    'target_type', a.target_type, 'target_id', a.target_id, 'payload', a.payload, 'payload_hash', a.payload_hash, 'expires_at', a.expires_at,
    'decided_by', app.actor_name(a.decided_by), 'decided_at', a.decided_at, 'decision_note', a.decision_note,
    'executed_at', a.executed_at, 'execution_result', a.execution_result, 'execution_error', a.execution_error, 'execution_attempts', a.execution_attempts,
    'execution_key', a.execution_key,
    'can_decide', v_eff = 'pending' and v_role is not null and app.role_rank(v_role) >= app.role_rank(act.approve_min_role) and (a.requested_by <> p_viewer or coalesce(s.allow_self_approval, false)),
    'can_retry', v_eff in ('approved', 'failed') and a.status in ('approved', 'failed') and v_role is not null and app.role_rank(v_role) >= app.role_rank(act.approve_min_role),
    'can_cancel', a.status in ('pending', 'approved', 'failed') and (a.requested_by = p_viewer or (v_role is not null and app.role_rank(v_role) >= app.role_rank('manager'))));
end $$;

create or replace function public.get_approval(p_org uuid, p_approval uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.approvals;
begin
  perform app.require_role(p_org, 'staff');
  select * into a from public.approvals where id = p_approval and org_id = p_org;
  if a.id is null or (a.requested_by <> auth.uid() and not app.has_role(p_org, 'manager')) then raise exception 'approval not found' using errcode = 'PT404'; end if;
  return app.approval_json(a, auth.uid()) || jsonb_build_object('events', coalesce((select jsonb_agg(jsonb_build_object('from_status', e.from_status, 'to_status', e.to_status,
      'actor', app.actor_name(e.actor_id), 'note', e.note, 'created_at', e.created_at) order by e.id) from public.approval_events e where e.approval_id = a.id), '[]'::jsonb));
end $$;

-- scope: 'inbox' = waiting for me to decide; 'mine' = I asked for them; 'all' = everything (managers)
create or replace function public.list_approvals(p_org uuid, p_scope text default 'inbox', p_status text default null, p_action text default null, p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.org_role;
begin
  v_role := app.require_role(p_org, 'staff');
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

create or replace function app.settle_after_rejection(p_request uuid, p_actor uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests;
begin
  select * into r from public.maintenance_requests where id = p_request for update;
  if r.status = 'awaiting_approval' and not exists (
       select 1 from public.approvals x join public.work_orders y on y.id = x.target_id where y.request_id = p_request and x.status in ('pending', 'approved', 'executing')) then
    perform app.apply_status(p_request, 'triaged', p_actor, 'Cost rejected: ' || p_note);
  end if;
end $$;
