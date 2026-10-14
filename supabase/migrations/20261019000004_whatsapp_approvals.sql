-- Phase 6: WhatsApp rent reminders go through the same draft -> request approval -> different approver -> recheck -> execute path.

do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.copilot_actions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.copilot_actions drop constraint %I', c);
  end loop;
  alter table public.copilot_actions add constraint copilot_actions_kind_check check (kind in ('create_maintenance_request', 'rent_reminder_draft', 'tenant_message_draft', 'send_rent_reminder',
    'send_tenant_message', 'void_charge', 'test_action', 'whatsapp_reminder_draft', 'send_whatsapp_reminder'));
  alter table public.copilot_actions add constraint copilot_actions_draft_policy_check check ((policy = 'none') = (kind in ('rent_reminder_draft', 'tenant_message_draft', 'whatsapp_reminder_draft')));
end $$;

create or replace function app.exec_copilot(a public.approvals) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ca public.copilot_actions; wc public.whatsapp_contacts; te public.tenants; s public.copilot_settings; c app.charge_state; v_wa jsonb; v_new boolean; v_result jsonb;
begin
  select * into ca from public.copilot_actions where id = a.target_id and org_id = a.org_id for update;
  if ca.id is null or ca.payload_hash <> a.payload_hash or ca.payload is distinct from a.payload then raise exception 'the stored proposal no longer matches the approval' using errcode = 'AP001'; end if;
  if ca.status = 'executed' then return ca.result; end if;
  if a.action_type = 'copilot.test_action' then
    insert into public.copilot_test_log (org_id, action_id, note, approved_by) values (a.org_id, ca.id, a.payload ->> 'note', a.decided_by);
    v_result := jsonb_build_object('logged', true, 'note', a.payload ->> 'note');
  elsif a.action_type = 'copilot.send_whatsapp_reminder' then
    s := app.copilot_settings_row(a.org_id);
    if not s.external_enabled then raise exception 'external communications were turned off' using errcode = 'AP001'; end if;
    select * into wc from public.whatsapp_contacts where id = (a.payload ->> 'contact_id')::uuid and org_id = a.org_id;
    if wc.id is null or wc.status <> 'verified' or wc.tenant_id is distinct from (a.payload ->> 'tenant_id')::uuid then raise exception 'the WhatsApp number is no longer verified for this tenant' using errcode = 'AP001'; end if;
    if wc.consent <> 'opted_in' then raise exception 'the tenant no longer accepts WhatsApp notices' using errcode = 'AP001'; end if;
    select * into c from app.charge_state where id = (a.payload ->> 'charge_id')::uuid and org_id = a.org_id;
    if c.id is null or c.voided_at is not null or c.outstanding_minor <= 0 then raise exception 'that charge no longer has anything outstanding' using errcode = 'AP001'; end if;
    v_wa := app.wa_enqueue(a.org_id, wc.id, 'template', a.payload ->> 'text', a.payload -> 'template', 'approval', a.execution_key, a.id, a.requested_by);
    if v_wa ->> 'status' = 'blocked' then raise exception 'WhatsApp would not accept it now (%)', v_wa ->> 'reason' using errcode = 'AP001'; end if;
    perform app.audit(a.org_id, 'copilot.whatsapp_queued', 'tenant', wc.tenant_id, null, jsonb_build_object('approval_id', a.id, 'template', a.payload #>> '{template,name}'), 'approved by ' || app.actor_name(a.decided_by));
    v_result := jsonb_build_object('queued', true, 'channel', 'whatsapp', 'to', app.wa_mask(wc.wa_id), 'tenant_id', wc.tenant_id);
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
  elsif p_action in ('copilot.test_action', 'copilot.send_rent_reminder', 'copilot.send_tenant_message', 'copilot.send_whatsapp_reminder') then
    -- Bound to the exact proposal the user saw, plus the facts a send depends on. The proposal's own status is NOT included (it moves to submitted).
    select app.sha256_hex(concat_ws('|', ca.id, ca.payload_hash, ca.kind,
             case ca.kind
               when 'send_rent_reminder' then (select concat_ws('|', c.outstanding_minor, coalesce(c.voided_at::text, ''), te.email, te.reminders_opt_out, te.archived_at is not null)
                                                 from app.charge_state c, public.tenants te where c.id = (ca.payload ->> 'charge_id')::uuid and te.id = (ca.payload ->> 'tenant_id')::uuid)
               when 'send_whatsapp_reminder' then (select concat_ws('|', c.outstanding_minor, coalesce(c.voided_at::text, ''), wc.status, wc.consent, coalesce(wc.tenant_id::text, ''))
                                                 from app.charge_state c, public.whatsapp_contacts wc where c.id = (ca.payload ->> 'charge_id')::uuid and wc.id = (ca.payload ->> 'contact_id')::uuid)
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
  elsif p_action in ('copilot.test_action', 'copilot.send_rent_reminder', 'copilot.send_tenant_message', 'copilot.send_whatsapp_reminder') then
    -- Only the system's own stored proposal can be submitted: identical payload, the caller's own, still open.
    select * into ca from public.copilot_actions where id = p_target and org_id = p_org;
    if ca.id is null or ca.user_id <> auth.uid() or ca.policy <> 'human_approval' or ca.status not in ('proposed', 'submitted') or ca.expires_at <= now()
       or p_action <> 'copilot.' || ca.kind or p_payload is distinct from ca.payload then
      raise exception 'the proposed payload does not match the stored proposal' using errcode = 'PT422';
    end if;
  end if;
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

create or replace function public.copilot_svc_propose_action(p_org uuid, p_user uuid, p_conversation uuid, p_kind text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_role public.org_role := app.role_of_user(p_org, p_user); s public.copilot_settings; v_payload jsonb; v_preview jsonb; v_policy text; v_status text := 'proposed';
  v_hash text; v_ex public.copilot_actions; a public.copilot_actions; v_ch app.charge_state; v_te public.tenants; v_draft public.copilot_actions; v_prop public.properties; v_unit public.units;
  v_subject text; v_body text; v_tenancy uuid; v_wc public.whatsapp_contacts; v_wch public.whatsapp_channels; v_name text; v_text text;
begin
  if v_role is null or app.role_rank(v_role) < app.role_rank('staff') then raise exception 'not found' using errcode = 'PT404'; end if;
  if p_kind like '%whatsapp%' and app.role_rank(v_role) < app.role_rank('manager') then raise exception 'only managers can prepare WhatsApp messages' using errcode = 'PT403'; end if;
  if p_conversation is not null and not exists (select 1 from public.copilot_conversations where id = p_conversation and org_id = p_org and user_id = p_user) then raise exception 'conversation not found' using errcode = 'PT404'; end if;
  s := app.copilot_settings_row(p_org);
  if (select count(*) from public.copilot_actions where org_id = p_org and user_id = p_user and status in ('draft', 'proposed') and expires_at > now()) >= 25 then
    raise exception 'too many open proposals; confirm or cancel some first' using errcode = 'PT429';
  end if;

  if p_kind = 'create_maintenance_request' then
    v_policy := 'user_confirmation';
    select * into v_prop from public.properties where id = (p_payload ->> 'property_id')::uuid and org_id = p_org;
    if v_prop.id is null or v_prop.archived_at is not null then raise exception 'property not found' using errcode = 'PT404'; end if;
    if (p_payload ->> 'unit_id') is not null then
      select * into v_unit from public.units where id = (p_payload ->> 'unit_id')::uuid and property_id = v_prop.id and org_id = p_org;
      if v_unit.id is null then raise exception 'unit not found in that property' using errcode = 'PT404'; end if;
    end if;
    if (p_payload ->> 'urgency_id') is not null and not exists (select 1 from public.urgency_levels where id = (p_payload ->> 'urgency_id')::uuid and org_id = p_org and archived_at is null) then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
    v_payload := jsonb_build_object('property_id', v_prop.id, 'unit_id', v_unit.id, 'title', app.clean_text(p_payload ->> 'title', 160), 'description', app.clean_text(p_payload ->> 'description', 4000),
      'category', coalesce(p_payload ->> 'category', 'other'), 'urgency_id', p_payload ->> 'urgency_id');
    if char_length(v_payload ->> 'title') < 3 or char_length(v_payload ->> 'description') < 1 then raise exception 'title and description are required' using errcode = 'PT422'; end if;
    v_preview := jsonb_build_object('summary', 'Create a maintenance request', 'fields', jsonb_build_array(
      jsonb_build_object('label', 'Where', 'value', v_prop.name || coalesce(' · unit ' || v_unit.reference, ' (whole property)')), jsonb_build_object('label', 'Title', 'value', v_payload ->> 'title'),
      jsonb_build_object('label', 'Details', 'value', v_payload ->> 'description'), jsonb_build_object('label', 'Category', 'value', v_payload ->> 'category')),
      'effect', 'Creates a request in the maintenance list. Anything mentioning a safety risk is escalated to a person automatically.');

  elsif p_kind = 'rent_reminder_draft' then
    v_policy := 'none'; v_status := 'draft';
    select * into v_ch from app.charge_state where id = (p_payload ->> 'charge_id')::uuid and org_id = p_org;
    if v_ch.id is null then raise exception 'charge not found' using errcode = 'PT404'; end if;
    if v_ch.voided_at is not null or v_ch.outstanding_minor <= 0 then raise exception 'that charge has nothing outstanding' using errcode = 'PT422'; end if;
    select tt.tenant_id into v_te.id from public.tenancy_tenants tt where tt.tenancy_id = v_ch.tenancy_id and tt.is_primary;
    select * into v_te from public.tenants where id = v_te.id and org_id = p_org;
    if v_te.id is null or v_te.email is null then raise exception 'the tenant has no email address on file' using errcode = 'PT422'; end if;
    v_subject := 'Rent reminder: ' || app.money_text(v_ch.outstanding_minor, v_ch.currency) || ' ' || v_ch.currency || ' outstanding';
    v_body := 'Hello ' || split_part(v_te.full_name, ' ', 1) || E',\n\nThis is a friendly reminder that ' || app.money_text(v_ch.outstanding_minor, v_ch.currency) || ' ' || v_ch.currency ||
              ' is outstanding for "' || v_ch.description || '", which was due on ' || v_ch.due_date || E'.\n\nIf you have already paid, thank you; please ignore this message. If you have any questions, just reply to this email.\n\nKind regards';
    v_payload := jsonb_build_object('charge_id', v_ch.id, 'tenancy_id', v_ch.tenancy_id, 'tenant_id', v_te.id, 'amount_minor', v_ch.outstanding_minor, 'currency', v_ch.currency, 'subject', v_subject, 'body', v_body);
    v_preview := jsonb_build_object('summary', 'Draft rent reminder (not sent)', 'fields', jsonb_build_array(jsonb_build_object('label', 'To', 'value', v_te.full_name || ' <' || v_te.email || '>'),
      jsonb_build_object('label', 'Subject', 'value', v_subject), jsonb_build_object('label', 'Message', 'value', v_body), jsonb_build_object('label', 'Amount', 'value', app.money_text(v_ch.outstanding_minor, v_ch.currency) || ' ' || v_ch.currency)),
      'effect', 'This is only a draft. Nothing has been sent. Sending needs a separate request and a manager''s approval.');

  elsif p_kind = 'tenant_message_draft' then
    v_policy := 'none'; v_status := 'draft';
    select * into v_te from public.tenants where id = (p_payload ->> 'tenant_id')::uuid and org_id = p_org;
    if v_te.id is null then raise exception 'tenant not found' using errcode = 'PT404'; end if;
    if v_te.email is null then raise exception 'the tenant has no email address on file' using errcode = 'PT422'; end if;
    v_subject := app.clean_text(p_payload ->> 'subject', 200); v_body := app.clean_text(p_payload ->> 'body', 3000);
    if char_length(v_subject) < 3 or char_length(v_body) < 3 then raise exception 'a subject and message are required' using errcode = 'PT422'; end if;
    v_payload := jsonb_build_object('tenant_id', v_te.id, 'subject', v_subject, 'body', v_body, 'authored_by', 'ai');
    v_preview := jsonb_build_object('summary', 'Draft message to a tenant (not sent)', 'fields', jsonb_build_array(jsonb_build_object('label', 'To', 'value', v_te.full_name || ' <' || v_te.email || '>'),
      jsonb_build_object('label', 'Subject', 'value', v_subject), jsonb_build_object('label', 'Message', 'value', v_body)),
      'effect', 'AI-written draft. Read it carefully: nothing has been sent. Sending needs a separate request and a manager''s approval.', 'ai_authored', true);

  elsif p_kind = 'whatsapp_reminder_draft' then
    v_policy := 'none'; v_status := 'draft';
    select * into v_ch from app.charge_state where id = (p_payload ->> 'charge_id')::uuid and org_id = p_org;
    if v_ch.id is null then raise exception 'charge not found' using errcode = 'PT404'; end if;
    if v_ch.voided_at is not null or v_ch.outstanding_minor <= 0 then raise exception 'that charge has nothing outstanding' using errcode = 'PT422'; end if;
    select * into v_wc from public.whatsapp_contacts where id = (p_payload ->> 'contact_id')::uuid and org_id = p_org;
    if v_wc.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
    if v_wc.status <> 'verified' or not exists (select 1 from public.tenancy_tenants tt where tt.tenancy_id = v_ch.tenancy_id and tt.tenant_id = v_wc.tenant_id) then
      raise exception 'that WhatsApp number is not verified for this tenancy' using errcode = 'PT422';
    end if;
    if v_wc.consent <> 'opted_in' then raise exception 'the tenant has not agreed to receive notices on WhatsApp' using errcode = 'PT422'; end if;
    select * into v_wch from public.whatsapp_channels where org_id = p_org;
    if v_wch.org_id is null or not v_wch.enabled or v_wch.rent_template_name is null then raise exception 'the WhatsApp channel or its rent-reminder template is not set up' using errcode = 'PT422'; end if;
    select full_name into v_name from public.tenants where id = v_wc.tenant_id;
    v_text := replace(replace(replace(coalesce(v_wch.rent_template_body, 'Hello {{1}}, {{2}} is outstanding and was due on {{3}}.'), '{{1}}', split_part(v_name, ' ', 1)),
                '{{2}}', app.money_text(v_ch.outstanding_minor, v_ch.currency) || ' ' || v_ch.currency), '{{3}}', v_ch.due_date::text);
    v_payload := jsonb_build_object('contact_id', v_wc.id, 'tenant_id', v_wc.tenant_id, 'charge_id', v_ch.id, 'amount_minor', v_ch.outstanding_minor, 'currency', v_ch.currency,
      'template', jsonb_build_object('name', v_wch.rent_template_name, 'lang', v_wch.rent_template_lang, 'params', jsonb_build_array(split_part(v_name, ' ', 1), app.money_text(v_ch.outstanding_minor, v_ch.currency) || ' ' || v_ch.currency, v_ch.due_date::text)),
      'text', v_text);
    v_preview := jsonb_build_object('summary', 'Draft WhatsApp rent reminder (not sent)', 'fields', jsonb_build_array(jsonb_build_object('label', 'To', 'value', v_name || ' on WhatsApp (' || app.wa_mask(v_wc.wa_id) || ')'),
      jsonb_build_object('label', 'Template', 'value', v_wch.rent_template_name), jsonb_build_object('label', 'Message', 'value', v_text), jsonb_build_object('label', 'Amount', 'value', app.money_text(v_ch.outstanding_minor, v_ch.currency) || ' ' || v_ch.currency)),
      'effect', 'This is only a draft. Nothing has been sent. Sending needs a separate request and a manager''s approval.');

  elsif p_kind = 'send_whatsapp_reminder' then
    v_policy := 'human_approval';
    if not s.external_enabled then raise exception 'External communications are turned off for this organization. An admin can enable them in Copilot settings.' using errcode = 'PT403'; end if;
    select * into v_draft from public.copilot_actions where id = (p_payload ->> 'draft_id')::uuid and org_id = p_org and user_id = p_user and kind = 'whatsapp_reminder_draft' and status = 'draft' and expires_at > now();
    if v_draft.id is null then raise exception 'draft not found, expired, or not yours' using errcode = 'PT404'; end if;
    v_payload := v_draft.payload || jsonb_build_object('draft_id', v_draft.id);
    v_preview := jsonb_build_object('summary', 'Send a rent reminder on WhatsApp', 'fields', v_draft.preview -> 'fields',
      'effect', 'Needs a manager''s approval. If approved, this approved template is sent to the tenant on WhatsApp. If anything it depends on changes, the approval is withdrawn.', 'draft_id', v_draft.id);

  elsif p_kind in ('send_rent_reminder', 'send_tenant_message') then
    v_policy := 'human_approval';
    if not s.external_enabled then raise exception 'External communications are turned off for this organization. An admin can enable them in Operations → Copilot.' using errcode = 'PT403'; end if;
    select * into v_draft from public.copilot_actions where id = (p_payload ->> 'draft_id')::uuid and org_id = p_org and user_id = p_user
       and kind = case p_kind when 'send_rent_reminder' then 'rent_reminder_draft' else 'tenant_message_draft' end and status = 'draft' and expires_at > now();
    if v_draft.id is null then raise exception 'draft not found, expired, or not yours' using errcode = 'PT404'; end if;
    v_payload := v_draft.payload || jsonb_build_object('draft_id', v_draft.id);       -- the text comes from the draft the user saw, never from the model
    select * into v_te from public.tenants where id = (v_payload ->> 'tenant_id')::uuid and org_id = p_org;
    v_preview := jsonb_build_object('summary', case p_kind when 'send_rent_reminder' then 'Send a rent reminder' else 'Send a message to a tenant' end, 'fields', v_draft.preview -> 'fields',
      'effect', 'Needs a manager''s approval. If approved, this exact text is emailed to the tenant. If anything it depends on changes, the approval is withdrawn.', 'draft_id', v_draft.id);

  elsif p_kind = 'void_charge' then
    v_policy := 'human_approval';
    select * into v_ch from app.charge_state where id = (p_payload ->> 'charge_id')::uuid and org_id = p_org;
    if v_ch.id is null then raise exception 'charge not found' using errcode = 'PT404'; end if;
    if v_ch.voided_at is not null then raise exception 'that charge is already void' using errcode = 'PT409'; end if;
    v_payload := jsonb_build_object('charge_id', v_ch.id, 'reason', app.clean_text(p_payload ->> 'reason', 500));
    if char_length(v_payload ->> 'reason') < 3 then raise exception 'a reason is required' using errcode = 'PT422'; end if;
    v_preview := jsonb_build_object('summary', 'Void a charge', 'fields', jsonb_build_array(jsonb_build_object('label', 'Charge', 'value', v_ch.description), jsonb_build_object('label', 'Amount', 'value', app.money_text(v_ch.effective_minor, v_ch.currency) || ' ' || v_ch.currency),
      jsonb_build_object('label', 'Due', 'value', v_ch.due_date::text), jsonb_build_object('label', 'Reason', 'value', v_payload ->> 'reason')), 'effect', 'Needs a manager''s approval. The charge stays on record as void.');

  elsif p_kind = 'test_action' then
    v_policy := 'human_approval';
    v_payload := jsonb_build_object('note', app.clean_text(p_payload ->> 'note', 500));
    if char_length(v_payload ->> 'note') < 3 then raise exception 'a note of at least 3 characters is required' using errcode = 'PT422'; end if;
    v_preview := jsonb_build_object('summary', 'Test action (harmless)', 'fields', jsonb_build_array(jsonb_build_object('label', 'Note to record', 'value', v_payload ->> 'note')),
      'effect', 'A safe way to try the approval process. If approved, the note is only written to a test log. Nothing is sent or changed.');
  else
    raise exception 'unsupported action' using errcode = 'PT422';
  end if;

  v_hash := app.sha256_hex(v_payload::text);
  -- Serialise identical proposals so a burst of the same request yields one card, not many.
  perform pg_advisory_xact_lock(hashtextextended('copilot:' || p_org || ':' || p_user || ':' || p_kind || ':' || v_hash, 0));
  select * into v_ex from public.copilot_actions where org_id = p_org and user_id = p_user and kind = p_kind and payload_hash = v_hash and status in ('draft', 'proposed', 'submitted') and expires_at > now()
     and conversation_id is not distinct from p_conversation limit 1;
  if v_ex.id is not null then return app.copilot_action_json(v_ex) || jsonb_build_object('duplicate', true); end if;
  insert into public.copilot_actions (org_id, conversation_id, user_id, kind, policy, status, payload, payload_hash, preview)
  values (p_org, p_conversation, p_user, p_kind, v_policy, v_status, v_payload, v_hash, v_preview) returning * into a;
  return app.copilot_action_json(a) || jsonb_build_object('duplicate', false);
end $$;

create or replace function public.copilot_submit_action(p_org uuid, p_action uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.copilot_actions; s public.copilot_settings; v_apr uuid; v_type text; v_target uuid; v_payload jsonb; v_note text;
begin
  perform app.require_role(p_org, 'staff');
  select * into a from public.copilot_actions where id = p_action and org_id = p_org and user_id = auth.uid() for update;
  if a.id is null then raise exception 'action not found' using errcode = 'PT404'; end if;
  if a.status = 'submitted' then return app.copilot_action_json(a) || jsonb_build_object('replayed', true); end if;
  if a.policy <> 'human_approval' then raise exception 'this action does not go through approval' using errcode = 'PT409'; end if;
  if a.status <> 'proposed' then raise exception 'this action is % and cannot be submitted', a.status using errcode = 'PT409'; end if;
  if a.expires_at <= now() then raise exception 'this proposal has expired; ask again' using errcode = 'PT409'; end if;
  s := app.copilot_settings_row(p_org);
  if a.kind in ('send_rent_reminder', 'send_tenant_message', 'send_whatsapp_reminder') and not s.external_enabled then raise exception 'External communications are turned off for this organization.' using errcode = 'PT403'; end if;
  select case a.kind when 'test_action' then 'copilot.test_action' when 'send_rent_reminder' then 'copilot.send_rent_reminder' when 'send_tenant_message' then 'copilot.send_tenant_message' when 'send_whatsapp_reminder' then 'copilot.send_whatsapp_reminder' when 'void_charge' then 'finance.void_charge' end into v_type;
  v_target := case when a.kind = 'void_charge' then (a.payload ->> 'charge_id')::uuid else a.id end;
  v_payload := a.payload;
  v_note := 'Requested via the AI copilot' || coalesce(': ' || (a.preview ->> 'summary'), '');
  v_apr := app.create_approval(p_org, v_type, v_target, v_payload, v_note, 72);
  update public.copilot_actions set status = 'submitted', approval_id = v_apr where id = a.id returning * into a;
  return app.copilot_action_json(a) || jsonb_build_object('replayed', false);
end $$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('copilot_svc_propose_action', 'copilot_submit_action') loop
    execute format('revoke execute on function %s from public, anon', r.f);
  end loop;
  revoke execute on function public.copilot_svc_propose_action(uuid, uuid, uuid, text, jsonb) from authenticated;
  grant execute on function public.copilot_svc_propose_action(uuid, uuid, uuid, text, jsonb) to service_role;
  grant execute on function public.copilot_submit_action(uuid, uuid) to authenticated;
end $$;
