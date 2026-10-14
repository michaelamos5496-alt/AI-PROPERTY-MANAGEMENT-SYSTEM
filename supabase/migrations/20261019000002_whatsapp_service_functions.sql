-- Phase 6, service-only functions. The webhook/worker calls these with the service role AFTER it has verified Meta's signature.
-- The organization is always derived from the business phone number id, never from anything a sender wrote.

create or replace function app.wa_mask(p text) returns text
language sql immutable set search_path = '' as $$ select case when p is null then null else '…' || right(p, 4) end $$;

create or replace function app.wa_ref(p uuid) returns text
language sql immutable set search_path = '' as $$ select 'MR-' || upper(left(replace(p::text, '-', ''), 8)) $$;

-- Same checks and side effects as app.create_request, but for a request raised through chat: the actor is the channel's intake member.
create or replace function app.wa_create_request(p_actor uuid, p_org uuid, p_property uuid, p_unit uuid, p_tenancy uuid, p_tenant uuid, p_title text,
  p_description text, p_category public.maintenance_category, p_urgent boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_urg public.urgency_levels; v_id uuid; r public.maintenance_requests; v_hit text;
begin
  perform app.ensure_maintenance_defaults(p_org);
  if p_urgent then
    select * into v_urg from public.urgency_levels where org_id = p_org and archived_at is null and tenant_selectable order by rank desc limit 1;
  end if;
  if v_urg.id is null then select * into v_urg from public.urgency_levels where org_id = p_org and is_default and archived_at is null; end if;
  if v_urg.id is null then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
  v_hit := app.keyword_hit(p_org, btrim(p_title) || ' ' || btrim(p_description));
  insert into public.maintenance_requests (org_id, property_id, unit_id, tenancy_id, tenant_id, reported_by, reported_via, title, description, category, urgency_id, initial_urgency_id, safety_flag)
  values (p_org, p_property, p_unit, p_tenancy, p_tenant, p_actor, 'whatsapp', btrim(p_title), btrim(p_description), coalesce(p_category, 'other'), v_urg.id, v_urg.id, v_hit is not null)
  returning * into r;
  v_id := r.id;
  insert into public.maintenance_status_history (org_id, request_id, from_status, to_status, actor_id, note) values (p_org, v_id, null, 'submitted', p_actor, 'Request submitted via WhatsApp');
  perform app.evaluate_escalation(v_id);
  perform app.notify_role(p_org, 'manager', 'maintenance.submitted', 'New maintenance request (WhatsApp): ' || r.title, left(r.description, 500), '/app?org=' || p_org || '#/maintenance/' || v_id, 'mr:' || v_id || ':submitted', null);
  return v_id;
end $$;

-- ------------------------------------------------------------------ routing + inbox
create or replace function public.wa_svc_channel(p_phone_number_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(x) from (
    select c.org_id, c.enabled, o.name as org_name, c.intake_user_id, c.urgent_contact_user_id, c.welcome_text, c.rent_template_name, c.rent_template_lang,
           c.update_template_name, c.update_template_lang, c.phone_number_id
      from public.whatsapp_channels c join public.organizations o on o.id = c.org_id where c.phone_number_id = p_phone_number_id) x $$;

create or replace function public.wa_svc_ingest(p_phone_number_id text, p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ch public.whatsapp_channels; e jsonb; v_new int := 0; v_dup int := 0; v_rows int;
begin
  select * into ch from public.whatsapp_channels where phone_number_id = p_phone_number_id;
  if ch.org_id is null then return jsonb_build_object('unknown_channel', true, 'received', 0, 'duplicates', 0); end if;
  for e in select * from jsonb_array_elements(p_events) loop
    insert into public.whatsapp_events (org_id, phone_number_id, kind, provider_id, contact_key, payload)
    values (ch.org_id, p_phone_number_id, e ->> 'kind', left(e ->> 'provider_id', 300), nullif(left(e ->> 'contact_key', 20), ''), e -> 'payload')
    on conflict (kind, provider_id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_new := v_new + 1; else v_dup := v_dup + 1; end if;
  end loop;
  return jsonb_build_object('unknown_channel', false, 'received', v_new, 'duplicates', v_dup);
end $$;

-- Hands out events one worker at a time. A contact's events run strictly in arrival order: a newer one is not offered while an older
-- one is still pending, retrying or being worked on.
create or replace function public.wa_svc_claim_events(p_worker text, p_limit int, p_lease_seconds int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with cand as (
    select e.id from public.whatsapp_events e
     where (e.status in ('pending', 'failed') or (e.status = 'processing' and e.locked_until < now())) and e.next_attempt_at <= now()
       and (e.contact_key is null or not exists (select 1 from public.whatsapp_events o where o.contact_key = e.contact_key and o.id < e.id and o.status in ('pending', 'failed', 'processing')))
     order by e.id limit least(greatest(p_limit, 1), 50) for update skip locked),
  upd as (
    update public.whatsapp_events e set status = 'processing', attempts = e.attempts + 1, locked_by = p_worker, locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10))
     from cand where e.id = cand.id returning e.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'org_id', org_id, 'phone_number_id', phone_number_id, 'kind', kind, 'provider_id', provider_id, 'payload', payload, 'attempts', attempts) order by id), '[]'::jsonb) into v from upd;
  return v;
end $$;

create or replace function public.wa_svc_finish_event(p_id bigint, p_worker text, p_outcome text, p_error text, p_delay_seconds int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.whatsapp_events; v_status text;
begin
  select * into e from public.whatsapp_events where id = p_id for update;
  if e.id is null or e.locked_by is distinct from p_worker or e.status <> 'processing' then return jsonb_build_object('ok', false); end if;
  if p_outcome in ('done', 'ignored') then v_status := p_outcome;
  elsif p_outcome = 'retry' then v_status := case when e.attempts >= 6 then 'dead' else 'failed' end;
  else v_status := 'dead'; end if;
  update public.whatsapp_events set status = v_status, last_error = left(p_error, 500), locked_by = null, locked_until = null,
    processed_at = case when v_status in ('done', 'ignored', 'dead') then now() end,
    next_attempt_at = case when v_status = 'failed' then now() + make_interval(secs => least(greatest(coalesce(p_delay_seconds, 30), 5) * power(2, e.attempts - 1)::int, 3600)) else next_attempt_at end
   where id = p_id;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

-- Stores the inbound message (idempotent on Meta's message id), upserts the contact, and applies flood control and the 24-hour window.
create or replace function public.wa_svc_begin_inbound(p_org uuid, p_wa_id text, p_name text, p_provider_id text, p_kind text, p_body text, p_ts timestamptz, p_max_per_10min int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; cv public.whatsapp_conversations; v_rows int; v_recent int; v_msg uuid; v_ts timestamptz := least(coalesce(p_ts, now()), now());
begin
  insert into public.whatsapp_contacts (org_id, wa_id, profile_name) values (p_org, p_wa_id, nullif(left(btrim(p_name), 120), ''))
  on conflict (org_id, wa_id) do update set profile_name = coalesce(nullif(left(btrim(p_name), 120), ''), public.whatsapp_contacts.profile_name)
  returning * into c;
  insert into public.whatsapp_messages (org_id, contact_id, direction, kind, body, origin, status, provider_message_id, created_at)
  values (p_org, c.id, 'in', case when p_kind = 'text' then 'text' else 'unsupported' end, left(p_body, 4096), 'contact', 'received', p_provider_id, v_ts)
  on conflict (direction, provider_message_id) where provider_message_id is not null do nothing returning id into v_msg;
  if v_msg is null then return jsonb_build_object('duplicate', true); end if;
  update public.whatsapp_contacts set last_inbound_at = greatest(coalesce(last_inbound_at, v_ts), v_ts) where id = c.id returning * into c;
  insert into public.whatsapp_conversations (org_id, contact_id) values (p_org, c.id) on conflict (contact_id) do nothing;
  select * into cv from public.whatsapp_conversations where contact_id = c.id for update;
  if cv.state <> 'idle' and cv.state_at < now() - interval '30 minutes' then
    update public.whatsapp_conversations set state = 'idle', context = '{}', state_at = now() where id = cv.id returning * into cv;
  end if;
  select count(*) into v_recent from public.whatsapp_messages where contact_id = c.id and direction = 'in' and created_at > now() - interval '10 minutes';
  return jsonb_build_object('duplicate', false, 'message_id', v_msg,
    'blocked', c.status = 'blocked',
    'rate_limited', v_recent > p_max_per_10min,
    'rate_notice', v_recent = p_max_per_10min + 1,
    'stale', v_ts < now() - interval '24 hours',
    'contact', jsonb_build_object('id', c.id, 'status', c.status, 'consent', c.consent, 'name', c.profile_name,
        'verified', c.status = 'verified' and c.verified_at > now() - interval '180 days', 'needs_reverify', c.status = 'verified' and c.verified_at <= now() - interval '180 days',
        'first_name', case when c.status = 'verified' then (select split_part(t.full_name, ' ', 1) from public.tenants t where t.id = c.tenant_id) end),
    'conversation', jsonb_build_object('id', cv.id, 'state', cv.state, 'context', cv.context, 'unknown_streak', cv.unknown_streak, 'handoff_status', cv.handoff_status));
end $$;

create or replace function public.wa_svc_set_state(p_org uuid, p_conversation uuid, p_state text, p_context jsonb, p_unknown int) returns void
language sql security definer set search_path = '' as $$
  update public.whatsapp_conversations set state = left(p_state, 40), context = coalesce(p_context, '{}'), unknown_streak = greatest(coalesce(p_unknown, 0), 0), state_at = now(), updated_at = now()
   where id = p_conversation and org_id = p_org $$;

-- ------------------------------------------------------------------ identity
create or replace function public.wa_svc_try_link(p_org uuid, p_contact uuid, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; k public.whatsapp_link_codes; t public.tenants; v_updated int;
begin
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org for update;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  if c.status = 'blocked' then return jsonb_build_object('result', 'blocked'); end if;
  if c.link_locked_until is not null and c.link_locked_until > now() then return jsonb_build_object('result', 'locked'); end if;
  select * into k from public.whatsapp_link_codes where code_hash = p_code_hash and org_id = p_org and used_at is null and revoked_at is null and expires_at > now();
  select * into t from public.tenants where id = k.tenant_id and org_id = p_org and archived_at is null;
  if k.id is null or t.id is null then
    -- Unknown, expired, used, revoked, another organization's and archived-tenant codes are indistinguishable to the sender.
    update public.whatsapp_contacts set
      link_fail_count = case when link_fail_since is null or link_fail_since < now() - interval '1 hour' then 1 else link_fail_count + 1 end,
      link_fail_since = case when link_fail_since is null or link_fail_since < now() - interval '1 hour' then now() else link_fail_since end,
      link_locked_until = case when (case when link_fail_since is null or link_fail_since < now() - interval '1 hour' then 1 else link_fail_count + 1 end) >= 5 then now() + interval '1 hour' end
     where id = c.id returning * into c;
    perform app.audit(p_org, 'whatsapp.link_failed', 'whatsapp_contact', c.id, null, jsonb_build_object('number', app.wa_mask(c.wa_id), 'failures', c.link_fail_count), null);
    return jsonb_build_object('result', case when c.link_locked_until is not null then 'locked' else 'invalid' end);
  end if;
  if c.status = 'verified' and c.tenant_id is distinct from k.tenant_id then return jsonb_build_object('result', 'already_linked'); end if;
  update public.whatsapp_link_codes set used_at = now(), used_by = c.id where id = k.id and used_at is null;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then return jsonb_build_object('result', 'invalid'); end if;
  update public.whatsapp_contacts set status = 'verified', tenant_id = k.tenant_id, verified_at = now(), verified_via = k.id, link_fail_count = 0, link_fail_since = null, link_locked_until = null where id = c.id;
  perform app.audit(p_org, 'whatsapp.contact_linked', 'tenant', k.tenant_id, null, jsonb_build_object('contact', c.id, 'number', app.wa_mask(c.wa_id), 'code', k.id), 'linked by a one-time code issued by staff');
  return jsonb_build_object('result', 'linked', 'first_name', split_part(t.full_name, ' ', 1));
end $$;

create or replace function public.wa_svc_set_consent(p_org uuid, p_contact uuid, p_value text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts;
begin
  if p_value not in ('opted_in', 'opted_out') then raise exception 'invalid consent value' using errcode = 'PT422'; end if;
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org for update;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  if c.status = 'blocked' then return jsonb_build_object('consent', c.consent, 'blocked', true); end if;
  update public.whatsapp_contacts set consent = p_value, consent_at = now(), opt_out_at = case when p_value = 'opted_out' then now() else null end where id = c.id;
  if p_value = 'opted_out' then
    update public.whatsapp_messages set status = 'blocked', error = 'recipient opted out', failed_at = now() where contact_id = c.id and direction = 'out' and status = 'queued';
  end if;
  perform app.audit(p_org, 'whatsapp.consent_' || p_value, 'whatsapp_contact', c.id, jsonb_build_object('consent', c.consent), jsonb_build_object('consent', p_value, 'number', app.wa_mask(c.wa_id)), null);
  return jsonb_build_object('consent', p_value);
end $$;

-- ------------------------------------------------------------------ outbound
-- The single gate for everything we send. Free text only inside the 24-hour customer-service window; templates need opt-in;
-- nothing goes to a contact who opted out (except the one acknowledgement of the opt-out itself); per-contact daily cap on automated sends.
create or replace function app.wa_enqueue(p_org uuid, p_contact uuid, p_kind text, p_body text, p_template jsonb, p_origin text, p_dedupe text, p_approval uuid, p_by uuid, p_ack boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; ch public.whatsapp_channels; m public.whatsapp_messages; v_reason text; v_id uuid;
begin
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org for update;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  select * into ch from public.whatsapp_channels where org_id = p_org;
  if p_dedupe is not null then
    select * into m from public.whatsapp_messages where org_id = p_org and dedupe_key = p_dedupe;
    if m.id is not null then return jsonb_build_object('id', m.id, 'status', m.status, 'duplicate', true); end if;
  end if;
  v_reason := case
    when ch.org_id is null or not ch.enabled then 'channel_disabled'
    when c.status = 'blocked' then 'blocked'
    when c.consent = 'opted_out' and not p_ack then 'opted_out'
    when p_kind = 'text' and (c.last_inbound_at is null or c.last_inbound_at <= now() - interval '24 hours') then 'window_closed'
    when p_kind = 'template' and (p_template is null or nullif(p_template ->> 'name', '') is null) then 'no_template'
    when p_kind = 'template' and c.consent <> 'opted_in' then 'no_consent'
    when p_origin in ('bot', 'system') and not p_ack and (select count(*) from public.whatsapp_messages x where x.contact_id = c.id and x.direction = 'out' and x.origin in ('bot', 'system')
           and x.status <> 'blocked' and x.created_at > now() - interval '24 hours') >= 15 then 'rate_limited'
  end;
  insert into public.whatsapp_messages (org_id, contact_id, direction, kind, body, template, origin, status, dedupe_key, error, approval_id, created_by, failed_at)
  values (p_org, c.id, 'out', p_kind, left(p_body, 4096), p_template, p_origin, case when v_reason is null then 'queued' else 'blocked' end, p_dedupe, v_reason, p_approval, p_by,
          case when v_reason is null then null else now() end)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', case when v_reason is null then 'queued' else 'blocked' end, 'reason', v_reason, 'duplicate', false);
end $$;

create or replace function public.wa_svc_enqueue(p_org uuid, p_contact uuid, p_kind text, p_body text, p_template jsonb, p_origin text, p_dedupe text, p_ack boolean) returns jsonb
language sql security definer set search_path = '' as $$ select app.wa_enqueue(p_org, p_contact, p_kind, p_body, p_template, p_origin, p_dedupe, null, null, coalesce(p_ack, false)) $$;

create or replace function public.wa_svc_claim_outbound(p_worker text, p_limit int, p_lease_seconds int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v jsonb := '[]'::jsonb; c public.whatsapp_contacts; ch public.whatsapp_channels; v_reason text;
begin
  for r in select m.id from public.whatsapp_messages m
            where m.direction = 'out' and (m.status = 'queued' or (m.status = 'sending' and m.locked_until < now())) and m.next_attempt_at <= now()
            order by m.created_at limit least(greatest(p_limit, 1), 50) for update skip locked loop
    perform 1 from public.whatsapp_messages where id = r.id for update;
    declare m public.whatsapp_messages; begin
      select * into m from public.whatsapp_messages where id = r.id;
      select * into c from public.whatsapp_contacts where id = m.contact_id;
      select * into ch from public.whatsapp_channels where org_id = m.org_id;
      -- re-check at send time: things change between queueing and sending
      v_reason := case
        when ch.org_id is null or not ch.enabled then 'channel_disabled'
        when c.status = 'blocked' then 'blocked'
        when c.consent = 'opted_out' and m.origin <> 'system_ack' and coalesce(m.dedupe_key, '') not like 'optout-ack:%' then 'opted_out'
        when m.kind = 'text' and (c.last_inbound_at is null or c.last_inbound_at <= now() - interval '24 hours') then 'window_closed'
        when m.kind = 'template' and c.consent <> 'opted_in' then 'no_consent'
      end;
      if v_reason is not null then
        update public.whatsapp_messages set status = 'blocked', error = v_reason, failed_at = now() where id = m.id;
        continue;
      end if;
      update public.whatsapp_messages set status = 'sending', attempts = attempts + 1, locked_by = p_worker, locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)) where id = m.id;
      v := v || jsonb_build_object('id', m.id, 'org_id', m.org_id, 'to', c.wa_id, 'phone_number_id', ch.phone_number_id, 'kind', m.kind, 'body', m.body, 'template', m.template, 'attempts', m.attempts + 1);
    end;
  end loop;
  return v;
end $$;

create or replace function public.wa_svc_complete_outbound(p_id uuid, p_worker text, p_provider_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.whatsapp_messages;
begin
  select * into m from public.whatsapp_messages where id = p_id for update;
  if m.id is null or m.locked_by is distinct from p_worker or m.status <> 'sending' then return jsonb_build_object('ok', false); end if;
  -- a status webhook may already have recorded a later state for this id; never move backwards
  update public.whatsapp_messages set status = 'sent', sent_at = now(), provider_message_id = left(p_provider_id, 200), locked_by = null, locked_until = null, error = null where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wa_svc_fail_outbound(p_id uuid, p_worker text, p_code text, p_error text, p_permanent boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.whatsapp_messages; v_dead boolean;
begin
  select * into m from public.whatsapp_messages where id = p_id for update;
  if m.id is null or m.locked_by is distinct from p_worker or m.status <> 'sending' then return jsonb_build_object('ok', false); end if;
  v_dead := coalesce(p_permanent, false) or m.attempts >= 6;
  update public.whatsapp_messages set status = case when v_dead then 'dead' else 'queued' end, error_code = left(p_code, 40), error = left(p_error, 500), locked_by = null, locked_until = null,
    failed_at = case when v_dead then now() end, next_attempt_at = case when v_dead then next_attempt_at else now() + make_interval(secs => least(30 * power(2, m.attempts - 1)::int, 3600)) end where id = p_id;
  if v_dead and m.created_by is not null then
    perform app.notify_user(m.org_id, m.created_by, 'whatsapp.delivery_failed', 'A WhatsApp message could not be delivered', coalesce(left(p_error, 300), 'delivery failed'),
      '/app?org=' || m.org_id || '#/whatsapp', 'wa:fail:' || m.id);
  end if;
  return jsonb_build_object('ok', true, 'status', case when v_dead then 'dead' else 'queued' end);
end $$;

-- Delivery receipts from Meta. They can arrive late, twice, or out of order: states only move forward, and a failure never overwrites delivered/read.
create or replace function public.wa_svc_apply_status(p_provider_id text, p_status text, p_ts timestamptz, p_code text, p_error text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.whatsapp_messages; v_rank int; v_cur int; v_ts timestamptz := coalesce(p_ts, now());
begin
  select * into m from public.whatsapp_messages where direction = 'out' and provider_message_id = p_provider_id for update;
  if m.id is null then return jsonb_build_object('found', false); end if;
  if p_status = 'failed' then
    if m.status in ('delivered', 'read') then return jsonb_build_object('found', true, 'applied', false); end if;
    update public.whatsapp_messages set status = 'failed', error_code = left(p_code, 40), error = left(p_error, 500), failed_at = v_ts where id = m.id;
    if p_code = '131050' then   -- the person told WhatsApp they do not want these messages
      update public.whatsapp_contacts set consent = 'opted_out', consent_at = now(), opt_out_at = now() where id = m.contact_id;
    end if;
    if m.created_by is not null then
      perform app.notify_user(m.org_id, m.created_by, 'whatsapp.delivery_failed', 'A WhatsApp message was not delivered', coalesce(left(p_error, 300), 'delivery failed'), '/app?org=' || m.org_id || '#/whatsapp', 'wa:fail:' || m.id);
    end if;
    return jsonb_build_object('found', true, 'applied', true);
  end if;
  v_rank := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  v_cur := case m.status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  if v_rank = 0 then return jsonb_build_object('found', true, 'applied', false); end if;
  update public.whatsapp_messages set
    sent_at = coalesce(sent_at, case when v_rank >= 1 then v_ts end),
    delivered_at = coalesce(delivered_at, case when v_rank >= 2 then v_ts end),
    read_at = coalesce(read_at, case when v_rank >= 3 then v_ts end),
    status = case when v_rank > v_cur or m.status = 'failed' then p_status else m.status end,
    error = case when v_rank > v_cur then null else error end
   where id = m.id;
  return jsonb_build_object('found', true, 'applied', v_rank > v_cur);
end $$;

-- ------------------------------------------------------------------ what the assistant may know
create or replace function public.wa_svc_faqs(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'question', question, 'keywords', keywords, 'answer', answer) order by created_at), '[]'::jsonb)
    from public.whatsapp_faqs where org_id = p_org and active $$;

create or replace function public.wa_svc_find_property(p_org uuid, p_text text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.exact desc, x.name), '[]'::jsonb) from (
    select p.id, p.name, lower(p.name) = lower(btrim(p_text)) as exact from public.properties p
     where p.org_id = p_org and p.archived_at is null and char_length(btrim(p_text)) >= 3 and p.name ilike app.like_pattern(p_text) order by (lower(p.name) = lower(btrim(p_text))) desc, p.name limit 4) x $$;

create or replace function public.wa_svc_find_unit(p_org uuid, p_property uuid, p_text text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'reference', u.reference)), '[]'::jsonb)
    from public.units u where u.org_id = p_org and u.property_id = p_property and u.archived_at is null and lower(u.reference) = lower(btrim(p_text)) $$;

-- Only for a verified, recently verified contact whose tenant is not archived. Everything else gets nothing.
create or replace function public.wa_svc_tenant_summary(p_org uuid, p_contact uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.whatsapp_contacts; t public.tenants;
begin
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org;
  if c.id is null or c.status <> 'verified' then return jsonb_build_object('verified', false, 'reason', 'unverified'); end if;
  if c.verified_at <= now() - interval '180 days' then return jsonb_build_object('verified', false, 'reason', 'reverify'); end if;
  select * into t from public.tenants where id = c.tenant_id and org_id = p_org and archived_at is null;
  if t.id is null then return jsonb_build_object('verified', false, 'reason', 'unverified'); end if;
  return jsonb_build_object('verified', true, 'first_name', split_part(t.full_name, ' ', 1),
    'tenancies', coalesce((select jsonb_agg(jsonb_build_object('tenancy_id', x.id, 'unit_id', u.id, 'property_id', pr.id, 'property_name', pr.name, 'unit_reference', u.reference) order by pr.name, u.reference)
        from public.tenancy_tenants tt join public.tenancies x on x.id = tt.tenancy_id join public.units u on u.id = x.unit_id join public.properties pr on pr.id = u.property_id
       where tt.tenant_id = t.id and x.org_id = p_org and x.status = 'active'), '[]'::jsonb),
    'balances', coalesce((select jsonb_agg(jsonb_build_object('currency', g.currency, 'outstanding_minor', g.o, 'overdue_minor', g.od, 'next_due_date', g.nd) order by g.currency) from (
        select cs.currency, sum(cs.outstanding_minor)::bigint o, coalesce(sum(cs.outstanding_minor) filter (where cs.is_overdue), 0)::bigint od, min(cs.due_date) filter (where cs.outstanding_minor > 0) nd
          from public.tenancy_tenants tt join public.tenancies x on x.id = tt.tenancy_id join app.charge_state cs on cs.tenancy_id = x.id
         where tt.tenant_id = t.id and x.org_id = p_org and x.status = 'active' and cs.voided_at is null group by cs.currency) g), '[]'::jsonb));
end $$;

create or replace function public.wa_svc_create_request(p_org uuid, p_contact uuid, p_property uuid, p_unit uuid, p_tenancy uuid, p_title text, p_description text,
  p_category public.maintenance_category, p_urgent boolean, p_source_msg text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; ch public.whatsapp_channels; lnk public.whatsapp_request_links; r public.maintenance_requests; v_id uuid; v_tenancy uuid; v_tenant uuid;
  v_verified boolean; v_n int;
begin
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org for update;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  select * into ch from public.whatsapp_channels where org_id = p_org;
  if ch.org_id is null or not ch.enabled then raise exception 'channel is not enabled' using errcode = 'PT403'; end if;
  if c.status = 'blocked' then raise exception 'contact is blocked' using errcode = 'PT403'; end if;
  select * into lnk from public.whatsapp_request_links where source_message_id = p_source_msg;
  if lnk.request_id is not null then
    select * into r from public.maintenance_requests where id = lnk.request_id;
    return jsonb_build_object('request_id', r.id, 'ref', app.wa_ref(r.id), 'escalated', r.escalation_required, 'duplicate', true);
  end if;
  v_verified := c.status = 'verified' and c.verified_at > now() - interval '180 days';
  select count(*) into v_n from public.whatsapp_request_links where contact_id = c.id and created_at > now() - interval '24 hours';
  if v_n >= (case when v_verified then 10 else 3 end) then raise exception 'daily limit of requests from this number reached' using errcode = 'PT429'; end if;
  if not exists (select 1 from public.properties where id = p_property and org_id = p_org and archived_at is null) then raise exception 'property not found' using errcode = 'PT404'; end if;
  if p_unit is not null and not exists (select 1 from public.units where id = p_unit and property_id = p_property and org_id = p_org and archived_at is null) then raise exception 'unit not found' using errcode = 'PT404'; end if;
  if v_verified and p_tenancy is not null then
    -- a verified tenant may only attach a request to a tenancy they are on
    select x.id into v_tenancy from public.tenancy_tenants tt join public.tenancies x on x.id = tt.tenancy_id
     where x.id = p_tenancy and x.org_id = p_org and x.status = 'active' and tt.tenant_id = c.tenant_id and x.unit_id = p_unit;
    if v_tenancy is null then raise exception 'that tenancy is not yours' using errcode = 'PT403'; end if;
    v_tenant := c.tenant_id;
  end if;
  v_id := app.wa_create_request(ch.intake_user_id, p_org, p_property, p_unit, v_tenancy, v_tenant, p_title, p_description, p_category, coalesce(p_urgent, false));
  select * into r from public.maintenance_requests where id = v_id;
  insert into public.whatsapp_request_links (request_id, org_id, contact_id, source_message_id, last_status_sent) values (v_id, p_org, c.id, p_source_msg, 'submitted');
  perform app.system_note(r, 'Reported through WhatsApp from ' || app.wa_mask(c.wa_id) || coalesce(' (' || nullif(c.profile_name, '') || ')', '') ||
    case when v_tenant is not null then '. The sender is a verified tenant: ' || (select full_name from public.tenants where id = v_tenant) || '.' else '. The sender is NOT verified; the property and unit were typed by them.' end);
  return jsonb_build_object('request_id', v_id, 'ref', app.wa_ref(v_id), 'escalated', r.escalation_required, 'duplicate', false);
end $$;

-- Status of requests raised from THIS chat (or, for a verified tenant, requests on their own tenancies). Nothing else is reachable.
create or replace function public.wa_svc_request_status(p_org uuid, p_contact uuid, p_ref text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.whatsapp_contacts; v_prefix text := lower(regexp_replace(coalesce(p_ref, ''), '^mr-', '', 'i')); v_verified boolean;
begin
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org;
  if c.id is null then return jsonb_build_object('items', '[]'::jsonb); end if;
  v_verified := c.status = 'verified' and c.verified_at > now() - interval '180 days';
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('ref', app.wa_ref(r.id), 'title', r.title, 'status', r.status, 'updated_at', r.updated_at) order by r.created_at desc) from (
    select r.* from public.maintenance_requests r
     where r.org_id = p_org
       and (r.id in (select request_id from public.whatsapp_request_links where contact_id = c.id)
            or (v_verified and r.tenant_id = c.tenant_id))
       and (v_prefix = '' or replace(r.id::text, '-', '') like v_prefix || '%')
     order by r.created_at desc limit 3) r), '[]'::jsonb));
end $$;

create or replace function public.wa_svc_handoff(p_org uuid, p_contact uuid, p_reason text, p_excerpt text, p_urgent boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; cv public.whatsapp_conversations; ch public.whatsapp_channels; s public.maintenance_settings; v_user uuid; v_title text; v_body text; v_link text; v_key text; v_n int;
begin
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org;
  select * into cv from public.whatsapp_conversations where contact_id = p_contact for update;
  if c.id is null or cv.id is null then raise exception 'conversation not found' using errcode = 'PT404'; end if;
  if cv.handoff_status = 'open' then
    if p_urgent and cv.handoff_reason not like 'URGENT:%' then update public.whatsapp_conversations set handoff_reason = left('URGENT: ' || p_reason, 300) where id = cv.id; else return jsonb_build_object('already_open', true); end if;
  else
    update public.whatsapp_conversations set handoff_status = 'open', handoff_reason = left(case when p_urgent then 'URGENT: ' else '' end || p_reason, 300), handoff_at = now(), handoff_resolved_by = null where id = cv.id returning * into cv;
  end if;
  select * into ch from public.whatsapp_channels where org_id = p_org;
  v_key := 'wa:handoff:' || cv.id || ':' || extract(epoch from cv.handoff_at)::bigint || case when p_urgent then ':u' else '' end;
  v_title := case when p_urgent then 'URGENT WhatsApp message' else 'WhatsApp conversation needs a person' end;
  v_body := p_reason || E'\n\nFrom ' || app.wa_mask(c.wa_id) || case when c.status = 'verified' then ' (verified tenant ' || (select full_name from public.tenants where id = c.tenant_id) || ')' else ' (NOT verified)' end ||
            E'\n\nThey wrote (untrusted text): “' || left(coalesce(p_excerpt, ''), 300) || '”';
  v_link := '/app?org=' || p_org || '#/whatsapp';
  v_user := ch.urgent_contact_user_id;
  if v_user is null or app.role_rank(coalesce(app.role_of_user(p_org, v_user), 'viewer')) < app.role_rank('manager') then
    s := app.settings(p_org); v_user := s.escalation_user_id;
    if v_user is not null and app.role_rank(coalesce(app.role_of_user(p_org, v_user), 'viewer')) < app.role_rank('manager') then v_user := null; end if;
  end if;
  if v_user is not null then
    perform app.notify_user(p_org, v_user, case when p_urgent then 'whatsapp.urgent' else 'whatsapp.handoff' end, v_title, v_body, v_link, v_key);
  else
    v_n := app.notify_role(p_org, 'admin', case when p_urgent then 'whatsapp.urgent' else 'whatsapp.handoff' end, v_title, v_body, v_link, v_key);
  end if;
  return jsonb_build_object('already_open', false, 'notified', coalesce(v_user::text, 'admins'));
end $$;

-- Status updates back to whoever raised a request through chat. Idempotent: one message per request per status.
create or replace function public.wa_svc_request_updates() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l record; ch public.whatsapp_channels; c public.whatsapp_contacts; v_label text; v_text text; v_res jsonb; v_n int := 0; v_skipped int := 0;
begin
  for l in select k.request_id, k.org_id, k.contact_id, r.status::text as status, r.title from public.whatsapp_request_links k join public.maintenance_requests r on r.id = k.request_id
            where k.last_status_sent is distinct from r.status::text and r.status::text <> 'submitted' limit 200 loop
    select * into ch from public.whatsapp_channels where org_id = l.org_id;
    select * into c from public.whatsapp_contacts where id = l.contact_id;
    v_label := case l.status when 'triaged' then 'has been reviewed' when 'awaiting_approval' then 'is being arranged' when 'assigned' then 'has been assigned for work' when 'in_progress' then 'is being worked on' when 'resolved' then 'has been marked resolved' when 'cancelled' then 'was cancelled' else l.status end;
    v_text := 'Update on your request ' || app.wa_ref(l.request_id) || ' (' || left(l.title, 80) || '): it ' || v_label || '.';
    if l.status = 'awaiting_approval' then
      update public.whatsapp_request_links set last_status_sent = l.status where request_id = l.request_id;   -- internal step; not worth a message
      continue;
    end if;
    if ch.org_id is not null and ch.enabled and c.last_inbound_at > now() - interval '24 hours' then
      v_res := app.wa_enqueue(l.org_id, l.contact_id, 'text', v_text, null, 'system', 'upd:' || l.request_id || ':' || l.status, null, null);
    elsif ch.org_id is not null and ch.enabled and ch.update_template_name is not null and c.consent = 'opted_in' then
      v_res := app.wa_enqueue(l.org_id, l.contact_id, 'template', v_text, jsonb_build_object('name', ch.update_template_name, 'lang', ch.update_template_lang, 'params', jsonb_build_array(app.wa_ref(l.request_id), v_label)), 'system', 'upd:' || l.request_id || ':' || l.status, null, null);
    else v_res := null; end if;
    update public.whatsapp_request_links set last_status_sent = l.status where request_id = l.request_id;
    if v_res is null then v_skipped := v_skipped + 1; else v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('queued', v_n, 'skipped', v_skipped);
end $$;

create or replace function public.wa_svc_purge() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  delete from public.whatsapp_events where status in ('done', 'ignored') and processed_at < now() - interval '30 days';
  get diagnostics v = row_count;
  return jsonb_build_object('events_deleted', v);
end $$;

create or replace function public.wa_svc_queue_stats() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'events', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.whatsapp_events group by status) a),
    'outbound', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.whatsapp_messages where direction = 'out' and created_at > now() - interval '7 days' group by status) b)) $$;
