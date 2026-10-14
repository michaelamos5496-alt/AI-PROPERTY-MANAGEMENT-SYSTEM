-- Phase 7: wire the entitlements, plan meters, quiet hours and the organization's time zone into the existing features.

create or replace function app.money_text(p_minor bigint, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select case when d = 0 then p_minor::text
    else (case when p_minor < 0 then '-' else '' end) || (abs(p_minor) / f)::text || '.' || lpad((abs(p_minor) % f)::text, d, '0') end
  from (select d, case d when 0 then 1 when 2 then 100 else 1000 end::bigint as f
          from (select case when p_currency in ('JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF', 'XOF', 'XAF', 'XPF', 'KMF', 'GNF', 'DJF', 'PYG', 'VUV') then 0 when p_currency in ('KWD', 'BHD', 'OMR', 'JOD', 'TND') then 3 else 2 end as d) a) x
$$;

create or replace function app.org_today(p_org uuid) returns date
language sql stable security definer set search_path = '' as $$
  select coalesce((now() at time zone coalesce(app.org_tz(p_org), (select timezone from public.properties where org_id = p_org and archived_at is null order by created_at limit 1), 'UTC'))::date, (now() at time zone 'UTC')::date) $$;

create or replace function public.copilot_svc_begin_turn(p_org uuid, p_user uuid, p_conversation uuid, p_request_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.copilot_settings; c public.copilot_conversations; v_role public.org_role := app.role_of_user(p_org, p_user); v_used bigint;
begin
  if v_role is null or app.role_rank(v_role) < app.role_rank('staff') then raise exception 'not found' using errcode = 'PT404'; end if;
  s := app.copilot_settings_row(p_org);
  if not s.enabled then raise exception 'the copilot is turned off for this organization' using errcode = 'PT403'; end if;
  perform app.require_feature(p_org, 'copilot');
  select * into c from public.copilot_conversations where id = p_conversation and org_id = p_org and user_id = p_user and status = 'active' for update;
  if c.id is null then raise exception 'conversation not found' using errcode = 'PT404'; end if;
  if c.running_since is not null and c.running_since > now() - interval '2 minutes' then raise exception 'the copilot is still working on your previous message' using errcode = 'PT409'; end if;
  if (select count(*) from public.copilot_conversations x where x.org_id = p_org and x.user_id = p_user and x.running_since > now() - interval '2 minutes' and x.id <> c.id) >= 2 then
    raise exception 'too many requests are running at once; wait for one to finish' using errcode = 'PT409';
  end if;
  if (select count(*) from public.copilot_messages m join public.copilot_conversations x on x.id = m.conversation_id where x.org_id = p_org and x.user_id = p_user and m.role = 'user' and m.created_at > now() - interval '1 hour') >= s.max_turns_per_user_hour then
    raise exception 'hourly message limit reached' using errcode = 'PT429';
  end if;
  select coalesce(cost_micro, 0) into v_used from public.copilot_usage where org_id = p_org and day = (now() at time zone 'UTC')::date;
  if coalesce(v_used, 0) >= s.daily_budget_micro then raise exception 'the daily AI budget for this organization is used up' using errcode = 'PT402'; end if;
  perform app.consume(p_org, 'ai_requests_month', 1);          -- the plan's monthly allowance; refused with a 402 when used up
  update public.copilot_conversations set running_since = now(), cancel_requested = false where id = c.id;
  return jsonb_build_object('title', c.title, 'external_enabled', s.external_enabled, 'role', v_role, 'org_name', (select name from public.organizations where id = p_org), 'today', app.org_today(p_org),
    'budget_remaining_micro', s.daily_budget_micro - coalesce(v_used, 0),
    'history', coalesce((select jsonb_agg(jsonb_build_object('role', h.role, 'content', left(h.content, 4000)) order by h.id)
                           from (select * from public.copilot_messages where conversation_id = c.id and status in ('ok', 'fallback') order by id desc limit 12) h), '[]'::jsonb));
end $$;

create or replace function public.wa_svc_channel(p_phone_number_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(x) from (
    select c.org_id, (c.enabled and coalesce((app.ent(c.org_id, 'whatsapp') ->> 'enabled')::boolean, false)) as enabled, o.name as org_name, c.intake_user_id, c.urgent_contact_user_id, c.welcome_text, c.rent_template_name, c.rent_template_lang,
           c.update_template_name, c.update_template_lang, c.phone_number_id
      from public.whatsapp_channels c join public.organizations o on o.id = c.org_id where c.phone_number_id = p_phone_number_id) x $$;

create or replace function public.wa_svc_begin_inbound(p_org uuid, p_wa_id text, p_name text, p_provider_id text, p_kind text, p_body text, p_ts timestamptz, p_max_per_10min int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; cv public.whatsapp_conversations; v_rows int; v_recent int; v_msg uuid; v_prev timestamptz; v_over boolean := false; v_ts timestamptz := least(coalesce(p_ts, now()), now());
begin
  insert into public.whatsapp_contacts (org_id, wa_id, profile_name) values (p_org, p_wa_id, nullif(left(btrim(p_name), 120), ''))
  on conflict (org_id, wa_id) do update set profile_name = coalesce(nullif(left(btrim(p_name), 120), ''), public.whatsapp_contacts.profile_name)
  returning * into c;
  insert into public.whatsapp_messages (org_id, contact_id, direction, kind, body, origin, status, provider_message_id, created_at)
  values (p_org, c.id, 'in', case when p_kind = 'text' then 'text' else 'unsupported' end, left(p_body, 4096), 'contact', 'received', p_provider_id, v_ts)
  on conflict (direction, provider_message_id) where provider_message_id is not null do nothing returning id into v_msg;
  if v_msg is null then return jsonb_build_object('duplicate', true); end if;
  v_prev := c.last_inbound_at;
  -- a new 24-hour conversation window counts against the plan's monthly allowance
  if v_ts > now() - interval '24 hours' and (v_prev is null or v_prev <= now() - interval '24 hours') then
    begin perform app.consume(p_org, 'whatsapp_conversations_month', 1);
    exception when sqlstate 'PT402' then v_over := true; end;
  end if;
  update public.whatsapp_contacts set last_inbound_at = greatest(coalesce(last_inbound_at, v_ts), v_ts) where id = c.id returning * into c;
  insert into public.whatsapp_conversations (org_id, contact_id) values (p_org, c.id) on conflict (contact_id) do nothing;
  select * into cv from public.whatsapp_conversations where contact_id = c.id for update;
  if cv.state <> 'idle' and cv.state_at < now() - interval '30 minutes' then
    update public.whatsapp_conversations set state = 'idle', context = '{}', state_at = now() where id = cv.id returning * into cv;
  end if;
  select count(*) into v_recent from public.whatsapp_messages where contact_id = c.id and direction = 'in' and created_at > now() - interval '10 minutes';
  return jsonb_build_object('duplicate', false, 'message_id', v_msg,
    'blocked', c.status = 'blocked',
    'over_limit', v_over,
    'rate_limited', v_recent > p_max_per_10min,
    'rate_notice', v_recent = p_max_per_10min + 1,
    'stale', v_ts < now() - interval '24 hours',
    'contact', jsonb_build_object('id', c.id, 'status', c.status, 'consent', c.consent, 'name', c.profile_name,
        'verified', c.status = 'verified' and c.verified_at > now() - interval '180 days', 'needs_reverify', c.status = 'verified' and c.verified_at <= now() - interval '180 days',
        'first_name', case when c.status = 'verified' then (select split_part(t.full_name, ' ', 1) from public.tenants t where t.id = c.tenant_id) end),
    'conversation', jsonb_build_object('id', cv.id, 'state', cv.state, 'context', cv.context, 'unknown_streak', cv.unknown_streak, 'handoff_status', cv.handoff_status));
end $$;

create or replace function app.wa_enqueue(p_org uuid, p_contact uuid, p_kind text, p_body text, p_template jsonb, p_origin text, p_dedupe text, p_approval uuid, p_by uuid, p_ack boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_contacts; ch public.whatsapp_channels; m public.whatsapp_messages; v_reason text; v_id uuid; v_next timestamptz := now(); v_m jsonb := app.market(p_org); v_tz text; v_loc timestamp; v_qs time; v_qe time; v_t time;
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
  -- Quiet hours (organization setting, in the organization's own time zone) hold back PROACTIVE messages only. Replies and staff messages are never delayed.
  if v_reason is null and p_origin in ('system', 'approval') and (v_m #>> '{comms,quiet_hours,start}') is not null then
    v_tz := v_m ->> 'timezone'; v_loc := now() at time zone v_tz; v_qs := (v_m #>> '{comms,quiet_hours,start}')::time; v_qe := (v_m #>> '{comms,quiet_hours,end}')::time; v_t := v_loc::time;
    if (v_qs > v_qe and (v_t >= v_qs or v_t < v_qe)) or (v_qs <= v_qe and v_t >= v_qs and v_t < v_qe) then
      v_next := ((case when v_qs > v_qe and v_t >= v_qs then v_loc::date + 1 else v_loc::date end) + v_qe) at time zone v_tz;
    end if;
  end if;
  insert into public.whatsapp_messages (org_id, contact_id, direction, kind, body, template, origin, status, dedupe_key, error, approval_id, created_by, failed_at, next_attempt_at)
  values (p_org, c.id, 'out', p_kind, left(p_body, 4096), p_template, p_origin, case when v_reason is null then 'queued' else 'blocked' end, p_dedupe, v_reason, p_approval, p_by,
          case when v_reason is null then null else now() end, v_next)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', case when v_reason is null then 'queued' else 'blocked' end, 'reason', v_reason, 'duplicate', false);
end $$;

create or replace function public.save_wa_channel(p_org uuid, p_phone_number_id text, p_display_number text, p_waba_id text, p_enabled boolean, p_intake_user uuid, p_urgent_user uuid,
  p_welcome_text text, p_rent_template_name text, p_rent_template_lang text, p_rent_template_body text, p_update_template_name text, p_update_template_lang text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform app.require_role(p_org, 'admin');
  if coalesce(p_enabled, false) then perform app.require_feature(p_org, 'whatsapp'); end if;
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

do $$ declare r record; begin
  for r in select p.oid::regprocedure as f, p.proname as pn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('copilot_svc_begin_turn', 'wa_svc_channel', 'wa_svc_begin_inbound', 'save_wa_channel') loop
    execute format('revoke execute on function %s from public, anon', r.f);
    if r.pn like '%\_svc\_%' then execute format('revoke execute on function %s from authenticated', r.f); execute format('grant execute on function %s to service_role', r.f);
    else execute format('grant execute on function %s to authenticated', r.f); end if;
  end loop;
end $$;
