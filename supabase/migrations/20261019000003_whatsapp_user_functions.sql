-- Phase 6, functions called by signed-in staff. Managers handle conversations; admins configure the channel.

create or replace function public.get_wa_channel(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ch public.whatsapp_channels;
begin
  perform app.require_role(p_org, 'admin');
  select * into ch from public.whatsapp_channels where org_id = p_org;
  return jsonb_build_object('configured', ch.org_id is not null,
    'channel', case when ch.org_id is null then null else jsonb_build_object('phone_number_id', ch.phone_number_id, 'display_number', ch.display_number, 'waba_id', ch.waba_id, 'enabled', ch.enabled,
        'intake_user_id', ch.intake_user_id, 'intake_user', app.actor_name(ch.intake_user_id), 'urgent_contact_user_id', ch.urgent_contact_user_id, 'urgent_contact', app.actor_name(ch.urgent_contact_user_id),
        'welcome_text', ch.welcome_text, 'rent_template_name', ch.rent_template_name, 'rent_template_lang', ch.rent_template_lang, 'rent_template_body', ch.rent_template_body,
        'update_template_name', ch.update_template_name, 'update_template_lang', ch.update_template_lang) end,
    'stats', jsonb_build_object(
      'contacts', (select count(*) from public.whatsapp_contacts where org_id = p_org),
      'verified', (select count(*) from public.whatsapp_contacts where org_id = p_org and status = 'verified'),
      'open_handoffs', (select count(*) from public.whatsapp_conversations where org_id = p_org and handoff_status = 'open'),
      'outbound_7d', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.whatsapp_messages where org_id = p_org and direction = 'out' and created_at > now() - interval '7 days' group by status) x),
      'pending_events', (select count(*) from public.whatsapp_events where org_id = p_org and status in ('pending', 'failed', 'processing'))));
end $$;

create or replace function public.save_wa_channel(p_org uuid, p_phone_number_id text, p_display_number text, p_waba_id text, p_enabled boolean, p_intake_user uuid, p_urgent_user uuid,
  p_welcome_text text, p_rent_template_name text, p_rent_template_lang text, p_rent_template_body text, p_update_template_name text, p_update_template_lang text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform app.require_role(p_org, 'admin');
  if p_phone_number_id is null or btrim(p_phone_number_id) !~ '^[0-9]{5,30}$' then raise exception 'phone number id must be the numeric id Meta shows for the business number' using errcode = 'PT422'; end if;
  if p_intake_user is null or app.role_rank(coalesce(app.role_of_user(p_org, p_intake_user), 'viewer')) < app.role_rank('manager') then
    raise exception 'the intake member must be a manager or above in this organization' using errcode = 'PT422';
  end if;
  if p_urgent_user is not null and app.role_rank(coalesce(app.role_of_user(p_org, p_urgent_user), 'viewer')) < app.role_rank('manager') then
    raise exception 'the urgent contact must be a manager or above in this organization' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.whatsapp_channels where phone_number_id = btrim(p_phone_number_id) and org_id <> p_org) then
    raise exception 'that WhatsApp number is already connected to another organization' using errcode = 'PT409';
  end if;
  select to_jsonb(c) - 'org_id' into v_before from public.whatsapp_channels c where org_id = p_org;
  insert into public.whatsapp_channels (org_id, phone_number_id, display_number, waba_id, enabled, intake_user_id, urgent_contact_user_id, welcome_text, rent_template_name, rent_template_lang,
    rent_template_body, update_template_name, update_template_lang, updated_by)
  values (p_org, btrim(p_phone_number_id), nullif(btrim(p_display_number), ''), nullif(btrim(p_waba_id), ''), coalesce(p_enabled, false), p_intake_user, p_urgent_user, nullif(btrim(p_welcome_text), ''),
    nullif(btrim(p_rent_template_name), ''), coalesce(nullif(btrim(p_rent_template_lang), ''), 'en'), nullif(btrim(p_rent_template_body), ''), nullif(btrim(p_update_template_name), ''), coalesce(nullif(btrim(p_update_template_lang), ''), 'en'), auth.uid())
  on conflict (org_id) do update set phone_number_id = excluded.phone_number_id, display_number = excluded.display_number, waba_id = excluded.waba_id, enabled = excluded.enabled,
    intake_user_id = excluded.intake_user_id, urgent_contact_user_id = excluded.urgent_contact_user_id, welcome_text = excluded.welcome_text, rent_template_name = excluded.rent_template_name,
    rent_template_lang = excluded.rent_template_lang, rent_template_body = excluded.rent_template_body, update_template_name = excluded.update_template_name,
    update_template_lang = excluded.update_template_lang, updated_by = auth.uid(), updated_at = now();
  perform app.audit(p_org, 'whatsapp.channel_saved', 'organization', p_org, v_before, jsonb_build_object('phone_number_id', btrim(p_phone_number_id), 'enabled', coalesce(p_enabled, false)), null);
  return public.get_wa_channel(p_org);
end $$;

-- ------------------------------------------------------------ FAQs
create or replace function public.list_wa_faqs(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'question', question, 'keywords', keywords, 'answer', answer, 'active', active) order by created_at) from public.whatsapp_faqs where org_id = p_org), '[]'::jsonb);
end $$;

create or replace function public.save_wa_faq(p_org uuid, p_faq uuid, p_question text, p_keywords jsonb, p_answer text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.whatsapp_faqs; v_kw text[];
begin
  perform app.require_role(p_org, 'admin');
  v_kw := coalesce((select array_agg(distinct lower(btrim(k))) from jsonb_array_elements_text(case when jsonb_typeof(p_keywords) = 'array' then p_keywords else '[]'::jsonb end) k where char_length(btrim(k)) between 2 and 40), '{}');
  if p_faq is null then
    insert into public.whatsapp_faqs (org_id, question, keywords, answer, active, created_by) values (p_org, btrim(p_question), v_kw, btrim(p_answer), coalesce(p_active, true), auth.uid()) returning * into f;
  else
    update public.whatsapp_faqs set question = btrim(p_question), keywords = v_kw, answer = btrim(p_answer), active = coalesce(p_active, active), updated_at = now() where id = p_faq and org_id = p_org returning * into f;
    if f.id is null then raise exception 'FAQ not found' using errcode = 'PT404'; end if;
  end if;
  perform app.audit(p_org, 'whatsapp.faq_saved', 'whatsapp_faq', f.id, null, jsonb_build_object('question', f.question, 'active', f.active), null);
  return jsonb_build_object('id', f.id, 'question', f.question, 'keywords', f.keywords, 'answer', f.answer, 'active', f.active);
end $$;

create or replace function public.delete_wa_faq(p_org uuid, p_faq uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'admin');
  delete from public.whatsapp_faqs where id = p_faq and org_id = p_org;
  if not found then raise exception 'FAQ not found' using errcode = 'PT404'; end if;
  perform app.audit(p_org, 'whatsapp.faq_deleted', 'whatsapp_faq', p_faq, null, null, null);
  return jsonb_build_object('deleted', p_faq);
end $$;

-- ------------------------------------------------------------ contacts, linking, handoffs
create or replace function public.list_wa_contacts(p_org uuid, p_status text, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'number', app.wa_mask(c.wa_id), 'name', c.profile_name, 'status', c.status, 'consent', c.consent, 'tenant_id', c.tenant_id,
      'tenant_name', (select full_name from public.tenants t where t.id = c.tenant_id), 'verified_at', c.verified_at, 'last_inbound_at', c.last_inbound_at,
      'window_open', c.last_inbound_at > now() - interval '24 hours', 'handoff', cv.handoff_status, 'handoff_reason', cv.handoff_reason) order by coalesce(c.last_inbound_at, c.created_at) desc)
    from (select * from public.whatsapp_contacts where org_id = p_org and (p_status is null or status = p_status) order by coalesce(last_inbound_at, created_at) desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) c
    left join public.whatsapp_conversations cv on cv.contact_id = c.id), '[]'::jsonb);
end $$;

create or replace function public.get_wa_contact(p_org uuid, p_contact uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.whatsapp_contacts; cv public.whatsapp_conversations;
begin
  perform app.require_role(p_org, 'manager');
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  select * into cv from public.whatsapp_conversations where contact_id = c.id;
  return jsonb_build_object('id', c.id, 'number', app.wa_mask(c.wa_id), 'name', c.profile_name, 'status', c.status, 'consent', c.consent, 'tenant_id', c.tenant_id,
    'tenant_name', (select full_name from public.tenants t where t.id = c.tenant_id), 'verified_at', c.verified_at, 'last_inbound_at', c.last_inbound_at,
    'window_open', c.last_inbound_at > now() - interval '24 hours', 'handoff', cv.handoff_status, 'handoff_reason', cv.handoff_reason, 'conversation_id', cv.id,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'kind', m.kind, 'body', m.body, 'origin', m.origin, 'status', m.status, 'error', m.error,
        'error_code', m.error_code, 'created_at', m.created_at, 'delivered_at', m.delivered_at, 'read_at', m.read_at) order by m.created_at)
      from (select * from public.whatsapp_messages where contact_id = c.id order by created_at desc limit 60) m), '[]'::jsonb));
end $$;

create or replace function public.create_wa_link_code(p_org uuid, p_tenant uuid, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenants; k public.whatsapp_link_codes;
begin
  perform app.require_role(p_org, 'manager');
  t := app.load_tenant(p_org, p_tenant);
  if t.archived_at is not null then raise exception 'the tenant is archived' using errcode = 'PT409'; end if;
  if not exists (select 1 from public.tenancy_tenants tt join public.tenancies x on x.id = tt.tenancy_id where tt.tenant_id = t.id and x.org_id = p_org and x.status = 'active') then
    raise exception 'the tenant needs an active tenancy before WhatsApp can be linked' using errcode = 'PT409';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid code' using errcode = 'PT422'; end if;
  update public.whatsapp_link_codes set revoked_at = now() where org_id = p_org and tenant_id = t.id and used_at is null and revoked_at is null;
  insert into public.whatsapp_link_codes (org_id, tenant_id, code_hash, created_by, expires_at) values (p_org, t.id, p_code_hash, auth.uid(), now() + interval '48 hours') returning * into k;
  perform app.audit(p_org, 'whatsapp.link_code_issued', 'tenant', t.id, null, jsonb_build_object('code', k.id, 'expires_at', k.expires_at), null);
  return jsonb_build_object('id', k.id, 'tenant_id', t.id, 'tenant_name', t.full_name, 'expires_at', k.expires_at);
end $$;

create or replace function public.unlink_wa_contact(p_org uuid, p_contact uuid, p_block boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts;
begin
  perform app.require_role(p_org, 'manager');
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org for update;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  update public.whatsapp_contacts set status = case when coalesce(p_block, false) then 'blocked' else 'unverified' end, tenant_id = null, verified_at = null, verified_via = null where id = c.id;
  update public.whatsapp_messages set status = 'blocked', error = 'contact unlinked', failed_at = now() where contact_id = c.id and direction = 'out' and status = 'queued';
  perform app.audit(p_org, case when coalesce(p_block, false) then 'whatsapp.contact_blocked' else 'whatsapp.contact_unlinked' end, 'whatsapp_contact', c.id,
    jsonb_build_object('status', c.status, 'tenant_id', c.tenant_id), jsonb_build_object('status', case when coalesce(p_block, false) then 'blocked' else 'unverified' end), null);
  return jsonb_build_object('id', c.id, 'status', case when coalesce(p_block, false) then 'blocked' else 'unverified' end);
end $$;

create or replace function public.list_wa_handoffs(p_org uuid, p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return coalesce((select jsonb_agg(jsonb_build_object('conversation_id', cv.id, 'contact_id', c.id, 'number', app.wa_mask(c.wa_id), 'name', c.profile_name, 'verified', c.status = 'verified',
      'tenant_name', (select full_name from public.tenants t where t.id = c.tenant_id), 'reason', cv.handoff_reason, 'since', cv.handoff_at, 'status', cv.handoff_status,
      'urgent', cv.handoff_reason like 'URGENT:%', 'window_open', c.last_inbound_at > now() - interval '24 hours') order by (cv.handoff_reason like 'URGENT:%') desc, cv.handoff_at)
    from public.whatsapp_conversations cv join public.whatsapp_contacts c on c.id = cv.contact_id
   where cv.org_id = p_org and cv.handoff_status = coalesce(p_status, 'open')), '[]'::jsonb);
end $$;

create or replace function public.resolve_wa_handoff(p_org uuid, p_conversation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  update public.whatsapp_conversations set handoff_status = 'resolved', handoff_resolved_by = auth.uid(), state = 'idle', context = '{}', unknown_streak = 0, updated_at = now()
   where id = p_conversation and org_id = p_org and handoff_status = 'open';
  if not found then raise exception 'no open handoff' using errcode = 'PT404'; end if;
  perform app.audit(p_org, 'whatsapp.handoff_resolved', 'whatsapp_conversation', p_conversation, null, null, null);
  return jsonb_build_object('resolved', p_conversation);
end $$;

-- A person types a reply. Only inside the 24-hour window (WhatsApp's rule), never to someone who opted out, always attributed.
create or replace function public.wa_staff_reply(p_org uuid, p_contact uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_role(p_org, 'manager');
  if char_length(btrim(coalesce(p_text, ''))) < 1 or char_length(p_text) > 1000 then raise exception 'write a message of up to 1000 characters' using errcode = 'PT422'; end if;
  v := app.wa_enqueue(p_org, p_contact, 'text', btrim(p_text), null, 'staff', 'staff:' || gen_random_uuid(), null, auth.uid());
  if v ->> 'status' = 'blocked' then
    raise exception '%', case v ->> 'reason'
      when 'window_closed' then 'WhatsApp only allows free-text replies within 24 hours of the tenant''s last message. Ask them to write first, or use an approved template.'
      when 'opted_out' then 'This person has opted out of WhatsApp messages.'
      when 'blocked' then 'This contact is blocked.'
      when 'channel_disabled' then 'The WhatsApp channel is turned off.'
      else 'The message could not be queued (' || (v ->> 'reason') || ').' end using errcode = 'PT409';
  end if;
  perform app.audit(p_org, 'whatsapp.staff_reply', 'whatsapp_contact', p_contact, null, jsonb_build_object('message', v ->> 'id'), null);
  return v;
end $$;

-- Overdue (or any outstanding) charges for a contact's tenant, for composing a reminder draft.
create or replace function public.wa_reminder_candidates(p_org uuid, p_contact uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.whatsapp_contacts;
begin
  perform app.require_role(p_org, 'manager');
  select * into c from public.whatsapp_contacts where id = p_contact and org_id = p_org;
  if c.id is null then raise exception 'contact not found' using errcode = 'PT404'; end if;
  if c.status <> 'verified' then return jsonb_build_object('eligible', false, 'reason', 'This number is not verified for a tenant.', 'charges', '[]'::jsonb); end if;
  return jsonb_build_object('eligible', c.consent = 'opted_in', 'reason', case when c.consent = 'opted_in' then null when c.consent = 'opted_out' then 'The tenant opted out of WhatsApp messages.' else 'The tenant has not agreed to receive notices on WhatsApp yet.' end,
    'charges', coalesce((select jsonb_agg(jsonb_build_object('id', cs.id, 'description', cs.description, 'due_date', cs.due_date, 'outstanding_minor', cs.outstanding_minor, 'currency', cs.currency, 'overdue', cs.is_overdue) order by cs.due_date)
       from public.tenancy_tenants tt join app.charge_state cs on cs.tenancy_id = tt.tenancy_id where tt.tenant_id = c.tenant_id and cs.org_id = p_org and cs.voided_at is null and cs.outstanding_minor > 0), '[]'::jsonb));
end $$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as f, p.proname as pn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'wa\_%' or p.proname like '%\_wa\_%') loop
    execute format('revoke execute on function %s from public, anon', r.f);
    if r.pn like 'wa\_svc\_%' then
      execute format('revoke execute on function %s from authenticated', r.f);
      execute format('grant execute on function %s to service_role', r.f);
    else
      execute format('grant execute on function %s to authenticated', r.f);
    end if;
  end loop;
end $$;
