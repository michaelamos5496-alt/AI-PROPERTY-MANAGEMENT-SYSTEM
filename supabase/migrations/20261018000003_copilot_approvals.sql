-- Phase 5: let the approval engine carry the copilot's actions. Same rules as every other approval: separate approver, recheck at execution.

create or replace function app.exec_copilot(a public.approvals) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ca public.copilot_actions; te public.tenants; s public.copilot_settings; c app.charge_state; v_new boolean; v_result jsonb;
begin
  select * into ca from public.copilot_actions where id = a.target_id and org_id = a.org_id for update;
  if ca.id is null or ca.payload_hash <> a.payload_hash or ca.payload is distinct from a.payload then raise exception 'the stored proposal no longer matches the approval' using errcode = 'AP001'; end if;
  if ca.status = 'executed' then return ca.result; end if;
  if a.action_type = 'copilot.test_action' then
    insert into public.copilot_test_log (org_id, action_id, note, approved_by) values (a.org_id, ca.id, a.payload ->> 'note', a.decided_by);
    v_result := jsonb_build_object('logged', true, 'note', a.payload ->> 'note');
  else
    s := app.copilot_settings_row(a.org_id);
    if not s.external_enabled then raise exception 'external communications were turned off' using errcode = 'AP001'; end if;
    select * into te from public.tenants where id = (a.payload ->> 'tenant_id')::uuid and org_id = a.org_id;
    if te.id is null or te.email is null or te.archived_at is not null then raise exception 'the tenant can no longer be emailed' using errcode = 'AP001'; end if;
    if a.action_type = 'copilot.send_rent_reminder' then
      if te.reminders_opt_out then raise exception 'the tenant has opted out of reminders' using errcode = 'AP001'; end if;
      select * into c from app.charge_state where id = (a.payload ->> 'charge_id')::uuid and org_id = a.org_id;
      if c.id is null or c.voided_at is not null or c.outstanding_minor <= 0 then raise exception 'that charge no longer has anything outstanding' using errcode = 'AP001'; end if;
    end if;
    v_new := app.notify_email(a.org_id, te.email, te.full_name, case a.action_type when 'copilot.send_rent_reminder' then 'reminder.rent_due' else 'tenant.message' end,
               a.payload ->> 'subject', a.payload ->> 'body', null, a.execution_key);
    perform app.audit(a.org_id, 'copilot.message_queued', 'tenant', te.id, null, jsonb_build_object('approval_id', a.id, 'subject', a.payload ->> 'subject'), 'approved by ' || app.actor_name(a.decided_by));
    v_result := jsonb_build_object('queued', true, 'to', app.mask_email(te.email), 'tenant_id', te.id, 'already_queued', not v_new);
  end if;
  update public.copilot_actions set status = 'executed', result = v_result, resolved_at = now() where id = ca.id;
  return v_result;
end $$;

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
  elsif p_action in ('copilot.test_action', 'copilot.send_rent_reminder', 'copilot.send_tenant_message') then
    -- Bound to the exact proposal the user saw, plus the facts a send depends on. The proposal's own status is NOT included (it moves to submitted).
    select app.sha256_hex(concat_ws('|', ca.id, ca.payload_hash, ca.kind,
             case ca.kind
               when 'send_rent_reminder' then (select concat_ws('|', c.outstanding_minor, coalesce(c.voided_at::text, ''), te.email, te.reminders_opt_out, te.archived_at is not null)
                                                 from app.charge_state c, public.tenants te where c.id = (ca.payload ->> 'charge_id')::uuid and te.id = (ca.payload ->> 'tenant_id')::uuid)
               when 'send_tenant_message' then (select concat_ws('|', te.email, te.archived_at is not null) from public.tenants te where te.id = (ca.payload ->> 'tenant_id')::uuid)
               else '' end))
      into v from public.copilot_actions ca where ca.id = p_target and ca.org_id = p_org;
  end if;
  return v;
end $$;

create or replace function app.validate_approval_payload(p_org uuid, p_action text, p_target uuid, p_payload jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare w public.work_orders; v_est public.work_order_estimates; ca public.copilot_actions;
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
  elsif p_action in ('copilot.test_action', 'copilot.send_rent_reminder', 'copilot.send_tenant_message') then
    -- Only the system's own stored proposal can be submitted: identical payload, the caller's own, still open.
    select * into ca from public.copilot_actions where id = p_target and org_id = p_org;
    if ca.id is null or ca.user_id <> auth.uid() or ca.policy <> 'human_approval' or ca.status not in ('proposed', 'submitted') or ca.expires_at <= now()
       or p_action <> 'copilot.' || ca.kind or p_payload is distinct from ca.payload then
      raise exception 'the proposed payload does not match the stored proposal' using errcode = 'PT422';
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
  v_type := case p_action when 'maintenance.approve_cost' then 'work_order' when 'finance.void_charge' then 'charge' else 'copilot_action' end;
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
    v_result := case a.action_type when 'maintenance.approve_cost' then app.exec_maintenance_approve_cost(a) when 'finance.void_charge' then app.exec_finance_void_charge(a)
                else app.exec_copilot(a) end;
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

-- The service-only functions take the acting user as an argument, so no signed-in user may call them.
-- Nothing the copilot adds is callable anonymously.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'copilot\_%' or p.proname like '%copilot%') loop
    execute format('revoke execute on function %s from public, anon', r.f);
    execute format('grant execute on function %s to authenticated', r.f);
  end loop;
end $$;
revoke execute on function public.copilot_svc_context(uuid, uuid), public.copilot_svc_begin_turn(uuid, uuid, uuid, text), public.copilot_svc_end_turn(uuid, uuid),
  public.copilot_svc_turn_cancelled(uuid, uuid), public.copilot_svc_append_message(uuid, uuid, uuid, text, text, jsonb, text, text, int, int, bigint, text),
  public.copilot_svc_record_tool_call(uuid, uuid, uuid, text, text, text, text, jsonb, text, text, int, int, text, uuid),
  public.copilot_svc_record_usage(uuid, bigint, bigint, bigint, boolean), public.copilot_svc_budget(uuid),
  public.copilot_svc_propose_action(uuid, uuid, uuid, text, jsonb) from authenticated;
grant execute on function public.copilot_svc_context(uuid, uuid), public.copilot_svc_begin_turn(uuid, uuid, uuid, text), public.copilot_svc_end_turn(uuid, uuid),
  public.copilot_svc_turn_cancelled(uuid, uuid), public.copilot_svc_append_message(uuid, uuid, uuid, text, text, jsonb, text, text, int, int, bigint, text),
  public.copilot_svc_record_tool_call(uuid, uuid, uuid, text, text, text, text, jsonb, text, text, int, int, text, uuid),
  public.copilot_svc_record_usage(uuid, bigint, bigint, bigint, boolean), public.copilot_svc_budget(uuid),
  public.copilot_svc_propose_action(uuid, uuid, uuid, text, jsonb) to service_role;
