-- Phase 7: billing state machine and the functions around it.
-- Payment success is only ever concluded from a provider event that the server verified (signature) and deduplicated, or from a
-- server-side fetch of the provider's own record. A browser returning from checkout changes nothing.

-- ------------------------------------------------------------------ reading
create or replace function app.entitlement_rows(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'kind', c.kind, 'unit', c.unit, 'metered', c.metered,
      'enabled', (e ->> 'enabled')::boolean, 'limit', e -> 'limit', 'source', e ->> 'source', 'used', case when c.kind = 'limit' then app.usage_now(p_org, c.key) end) order by c.sort), '[]'::jsonb)
  from public.entitlement_catalog c, lateral (select app.ent(p_org, c.key) as e) x $$;

create or replace function public.get_entitlements(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions; v_plan text := app.effective_plan(p_org);
begin
  perform app.require_role(p_org, 'staff');
  select * into s from public.subscriptions where org_id = p_org;
  return jsonb_build_object('plan', jsonb_build_object('code', v_plan, 'name', app.plan_name(v_plan)), 'status', s.status, 'subscribed_plan', s.plan_code,
    'lapsed', v_plan is distinct from s.plan_code, 'trial_ends_at', case when s.status = 'trialing' then s.trial_ends_at end,
    'past_due', s.status = 'past_due', 'grace_until', s.grace_until, 'cancel_at_period_end', s.cancel_at_period_end, 'current_period_end', s.current_period_end,
    'entitlements', app.entitlement_rows(p_org));
end $$;

-- Raises a 402 with a plain explanation when the plan does not include a feature. Used by server code that cannot rely on a table trigger (e.g. exports).
create or replace function public.require_entitlement(p_org uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  perform app.require_feature(p_org, p_key);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.get_billing(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  perform app.require_role(p_org, 'admin');
  select * into s from public.subscriptions where org_id = p_org;
  return public.get_entitlements(p_org) || jsonb_build_object(
    'subscription', jsonb_build_object('plan_code', s.plan_code, 'status', s.status, 'provider', s.provider, 'currency', s.currency, 'interval', s.interval, 'current_period_end', s.current_period_end,
        'last_payment_at', s.last_payment_at, 'last_failure_at', s.last_failure_at, 'cancelled_at', s.cancelled_at, 'has_provider_subscription', s.provider_subscription_ref is not null),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('code', p.code, 'name', p.name, 'description', p.description, 'trial_days', p.trial_days,
        'entitlements', (select jsonb_agg(jsonb_build_object('key', pe.key, 'label', c.label, 'unit', c.unit, 'kind', c.kind, 'enabled', pe.enabled, 'limit', pe.limit_value) order by c.sort)
                           from public.plan_entitlements pe join public.entitlement_catalog c on c.key = pe.key where pe.plan_code = p.code),
        'prices', coalesce((select jsonb_agg(jsonb_build_object('currency', pr.currency, 'interval', pr.interval, 'amount_minor', pr.amount_minor, 'provider', pr.provider) order by pr.currency, pr.interval)
                            from public.plan_prices pr where pr.plan_code = p.code and pr.active), '[]'::jsonb)) order by p.sort)
        from public.plans p where p.active and p.public), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('type', e.type, 'from', e.from_status, 'to', e.to_status, 'plan', e.plan_code, 'provider', e.provider, 'at', e.created_at, 'detail', e.detail) order by e.id desc)
        from (select * from public.subscription_events where org_id = p_org order by id desc limit 20) e), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------ checkout
-- Records that WE started a checkout, with the price we expect. The payment is later matched to this record by reference.
create or replace function public.begin_checkout(p_org uuid, p_plan text, p_interval text, p_currency text, p_provider text, p_reference text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pr public.plan_prices; pl public.plans;
begin
  perform app.require_role(p_org, 'admin');
  select * into pl from public.plans where code = p_plan and active and public;
  if pl.code is null then raise exception 'that plan is not available' using errcode = 'PT404'; end if;
  select * into pr from public.plan_prices where plan_code = p_plan and currency = upper(p_currency) and interval = p_interval and provider = p_provider and active;
  if pr.id is null then raise exception '% is not offered in % billed %', pl.name, upper(p_currency), p_interval using errcode = 'PT422'; end if;
  if p_reference is null or char_length(p_reference) < 8 then raise exception 'reference required' using errcode = 'PT422'; end if;
  insert into public.billing_checkouts (reference, org_id, plan_code, interval, currency, provider, amount_minor, created_by) values (p_reference, p_org, p_plan, p_interval, pr.currency, p_provider, pr.amount_minor, auth.uid());
  perform app.sub_log(p_org, 'checkout_started', null, null, p_plan, p_provider, p_reference, jsonb_build_object('currency', pr.currency, 'interval', p_interval, 'amount_minor', pr.amount_minor));
  return jsonb_build_object('reference', p_reference, 'amount_minor', pr.amount_minor, 'currency', pr.currency, 'plan', p_plan, 'interval', p_interval, 'provider_plan_ref', pr.provider_plan_ref);
end $$;

-- ------------------------------------------------------------------ applying provider events (service only)
create or replace function public.billing_svc_record_event(p_provider text, p_event_id text, p_type text, p_payload jsonb, p_normalized jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.billing_events (provider, provider_event_id, type, payload, normalized) values (p_provider, left(p_event_id, 300), left(p_type, 80), p_payload, p_normalized)
  on conflict (provider, provider_event_id) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('duplicate', true, 'id', (select id from public.billing_events where provider = p_provider and provider_event_id = left(p_event_id, 300))); end if;
  return jsonb_build_object('duplicate', false, 'id', v_id);
end $$;

create or replace function app.billing_apply(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ev public.billing_events; n jsonb; s public.subscriptions; co public.billing_checkouts; v_org uuid; v_kind text; v_plan text; v_interval text; v_currency text; v_price public.plan_prices;
  v_occ timestamptz; v_start timestamptz; v_end timestamptz; v_cfg public.billing_config := app.billing_cfg(); v_amount bigint; v_from text; v_prov_plan text; v_stale boolean;
begin
  select * into ev from public.billing_events where id = p_id for update;
  if ev.id is null then raise exception 'event not found'; end if;
  if ev.status <> 'pending' then return jsonb_build_object('status', ev.status, 'org_id', ev.org_id); end if;
  n := ev.normalized; v_kind := n ->> 'kind'; v_occ := coalesce((n ->> 'occurred_at')::timestamptz, ev.received_at);
  v_amount := (n ->> 'amount_minor')::bigint; v_prov_plan := n ->> 'plan_ref';

  select * into co from public.billing_checkouts where reference = n ->> 'reference' and provider = ev.provider;
  v_org := co.org_id;
  if v_org is null and n ->> 'subscription_ref' is not null then select org_id into v_org from public.subscriptions where provider = ev.provider and provider_subscription_ref = n ->> 'subscription_ref'; end if;
  if v_org is null and n ->> 'customer_ref' is not null then select org_id into v_org from public.subscriptions where provider = ev.provider and provider_customer_ref = n ->> 'customer_ref'; end if;
  if v_org is null then
    -- the event can arrive before the one that links it to an organization; keep it and try again a few times
    update public.billing_events set attempts = attempts + 1, status = case when attempts + 1 >= 8 then 'ignored' else 'pending' end,
      error = case when attempts + 1 >= 8 then 'no organization could be matched to this event' else 'waiting to match an organization' end, processed_at = case when attempts + 1 >= 8 then now() end where id = ev.id;
    return jsonb_build_object('status', case when ev.attempts + 1 >= 8 then 'ignored' else 'pending' end);
  end if;
  select * into s from public.subscriptions where org_id = v_org for update;
  v_from := s.status;

  if v_kind in ('paid', 'subscribed') then
    v_plan := coalesce(co.plan_code, (select plan_code from public.plan_prices where provider = ev.provider and provider_plan_ref = v_prov_plan limit 1), s.plan_code);
    v_interval := coalesce(co.interval, (select interval from public.plan_prices where provider = ev.provider and provider_plan_ref = v_prov_plan limit 1), s.interval, 'monthly');
    v_currency := coalesce(co.currency, n ->> 'currency', s.currency);
  end if;

  if v_kind = 'paid' then
    select * into v_price from public.plan_prices where plan_code = v_plan and currency = v_currency and interval = v_interval and provider = ev.provider and active;
    -- never activate on a payment that is not for the price we expect
    if v_amount is not null and (v_price.id is null or v_amount < v_price.amount_minor or coalesce(n ->> 'currency', v_currency) <> v_currency) then
      update public.billing_events set status = 'rejected', org_id = v_org, processed_at = now(), error = 'payment does not match the plan price or currency' where id = ev.id;
      if co.reference is not null then update public.billing_checkouts set status = 'rejected' where reference = co.reference; end if;
      perform app.sub_log(v_org, 'payment_rejected', s.status, s.status, v_plan, ev.provider, ev.provider_event_id, jsonb_build_object('amount_minor', v_amount, 'currency', n ->> 'currency', 'expected', v_price.amount_minor));
      return jsonb_build_object('status', 'rejected', 'org_id', v_org);
    end if;
    v_stale := s.last_payment_at is not null and v_occ <= s.last_payment_at;
    if not v_stale then
      v_start := v_occ;
      v_end := coalesce((n ->> 'period_end')::timestamptz, v_start + case v_interval when 'annual' then interval '1 year' else interval '1 month' end);
      update public.subscriptions set plan_code = v_plan, status = 'active', provider = ev.provider, interval = v_interval, currency = v_currency, current_period_start = v_start,
        current_period_end = greatest(v_end, coalesce(current_period_end, v_end)), grace_until = null, last_payment_at = v_occ, cancelled_at = null,
        cancel_at_period_end = case when co.reference is not null then false else cancel_at_period_end end,
        provider_customer_ref = coalesce(n ->> 'customer_ref', provider_customer_ref), provider_subscription_ref = coalesce(n ->> 'subscription_ref', provider_subscription_ref) where org_id = v_org;
      if co.reference is not null then update public.billing_checkouts set status = 'paid' where reference = co.reference; end if;
      perform app.sub_log(v_org, 'payment_succeeded', v_from, 'active', v_plan, ev.provider, ev.provider_event_id, jsonb_build_object('amount_minor', v_amount, 'currency', v_currency, 'period_end', v_end));
      if v_plan is distinct from s.plan_code then
        perform app.sub_log(v_org, 'plan_changed', v_from, 'active', v_plan, ev.provider, ev.provider_event_id, jsonb_build_object('from_plan', s.plan_code));
        perform app.notify_role(v_org, 'admin', 'billing.plan_changed', 'Your plan is now ' || app.plan_name(v_plan), 'Thank you. Your payment was received.', '/app?org=' || v_org || '#/billing', 'billing:plan:' || ev.id);
      end if;
    end if;
  elsif v_kind = 'subscribed' then
    update public.subscriptions set provider = ev.provider, provider_customer_ref = coalesce(n ->> 'customer_ref', provider_customer_ref), provider_subscription_ref = coalesce(n ->> 'subscription_ref', provider_subscription_ref),
      plan_code = case when status in ('active', 'trialing') then coalesce(v_plan, plan_code) else plan_code end where org_id = v_org;
    perform app.sub_log(v_org, 'subscription_linked', v_from, v_from, v_plan, ev.provider, ev.provider_event_id, jsonb_build_object('subscription_ref', n ->> 'subscription_ref'));
  elsif v_kind = 'failed' then
    if s.last_payment_at is null or v_occ >= s.last_payment_at then
      update public.subscriptions set status = case when status in ('active', 'trialing', 'past_due') then 'past_due' else status end, last_failure_at = v_occ,
        grace_until = case when status = 'past_due' then grace_until else now() + make_interval(days => v_cfg.grace_days) end where org_id = v_org;
      perform app.sub_log(v_org, 'payment_failed', v_from, 'past_due', s.plan_code, ev.provider, ev.provider_event_id, jsonb_build_object('grace_days', v_cfg.grace_days));
      perform app.notify_role(v_org, 'admin', 'billing.past_due', 'Your subscription payment failed', 'Please update your payment method within ' || v_cfg.grace_days || ' days to keep your plan.', '/app?org=' || v_org || '#/billing', 'billing:pd:' || ev.id);
    end if;
  elsif v_kind = 'cancel_scheduled' then
    update public.subscriptions set cancel_at_period_end = true where org_id = v_org;
    perform app.sub_log(v_org, 'cancel_scheduled', v_from, v_from, s.plan_code, ev.provider, ev.provider_event_id);
  elsif v_kind = 'ended' then
    if s.last_payment_at is null or v_occ >= s.last_payment_at then
      update public.subscriptions set status = 'cancelled', cancelled_at = v_occ where org_id = v_org and status <> 'expired';
      perform app.sub_log(v_org, 'subscription_ended', v_from, 'cancelled', s.plan_code, ev.provider, ev.provider_event_id);
    end if;
  elsif v_kind = 'snapshot' then
    -- the provider's own record, fetched by us (reconciliation)
    update public.subscriptions set last_reconciled_at = now(),
      status = case n ->> 'status' when 'active' then 'active' when 'non_renewing' then 'active' when 'attention' then 'past_due' when 'cancelled' then 'cancelled' else status end,
      cancel_at_period_end = (n ->> 'status') in ('non_renewing', 'cancelled'),
      current_period_end = coalesce((n ->> 'period_end')::timestamptz, current_period_end),
      grace_until = case when (n ->> 'status') = 'attention' then coalesce(grace_until, now() + make_interval(days => v_cfg.grace_days)) when (n ->> 'status') = 'active' then null else grace_until end where org_id = v_org;
    perform app.sub_log(v_org, 'reconciled', v_from, (select status from public.subscriptions where org_id = v_org), s.plan_code, ev.provider, ev.provider_event_id, jsonb_build_object('provider_status', n ->> 'status'));
  end if;
  update public.billing_events set status = 'processed', org_id = v_org, processed_at = now(), error = null where id = ev.id;
  return jsonb_build_object('status', 'processed', 'org_id', v_org);
end $$;

create or replace function public.billing_svc_apply(p_id bigint) returns jsonb
language sql security definer set search_path = '' as $$ select app.billing_apply(p_id) $$;

create or replace function public.billing_svc_apply_pending() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select id from public.billing_events where status = 'pending' order by id limit 100 loop perform app.billing_apply(r.id); n := n + 1; end loop;
  return jsonb_build_object('tried', n);
end $$;

-- Time-based transitions and reminders. Idempotent.
create or replace function public.billing_svc_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_exp int := 0; v_pd int := 0; v_soon int := 0; v_cfg public.billing_config := app.billing_cfg();
begin
  for r in select * from public.subscriptions where status = 'trialing' and trial_ends_at <= now() for update loop
    update public.subscriptions set status = 'expired' where id = r.id;
    perform app.sub_log(r.org_id, 'trial_expired', 'trialing', 'expired', r.plan_code, r.provider, null); v_exp := v_exp + 1;
  end loop;
  for r in select * from public.subscriptions where status = 'trialing' and trial_ends_at between now() and now() + interval '3 days' loop
    perform app.notify_role(r.org_id, 'admin', 'billing.trial_ending', 'Your trial ends soon', 'Choose a plan to keep your features. Your data is never deleted.', '/app?org=' || r.org_id || '#/billing', 'billing:trial:' || r.org_id || ':' || r.trial_ends_at::date);
    v_soon := v_soon + 1;
  end loop;
  -- a paid period that ended with no renewal event: start the grace period (reconciliation may still confirm a payment)
  for r in select * from public.subscriptions where status = 'active' and current_period_end is not null and current_period_end + interval '1 day' <= now() for update loop
    update public.subscriptions set status = 'past_due', grace_until = now() + make_interval(days => v_cfg.grace_days) where id = r.id;
    perform app.sub_log(r.org_id, 'period_ended_unpaid', 'active', 'past_due', r.plan_code, r.provider, null); v_pd := v_pd + 1;
  end loop;
  for r in select * from public.subscriptions where status = 'past_due' and grace_until <= now() for update loop
    update public.subscriptions set status = 'expired' where id = r.id;
    perform app.sub_log(r.org_id, 'grace_expired', 'past_due', 'expired', r.plan_code, r.provider, null); v_exp := v_exp + 1;
  end loop;
  for r in select * from public.subscriptions where status = 'cancelled' and coalesce(current_period_end, now()) <= now() for update loop
    update public.subscriptions set status = 'expired' where id = r.id;
    perform app.sub_log(r.org_id, 'cancelled_period_ended', 'cancelled', 'expired', r.plan_code, r.provider, null); v_exp := v_exp + 1;
  end loop;
  return jsonb_build_object('expired', v_exp, 'past_due', v_pd, 'trial_reminders', v_soon);
end $$;

-- Subscriptions whose provider record should be re-read (renewal due, payment trouble, or never reconciled).
create or replace function public.billing_svc_reconcile_list(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', s.org_id, 'provider', s.provider, 'subscription_ref', s.provider_subscription_ref)), '[]'::jsonb)
    from (select * from public.subscriptions where provider <> 'manual' and provider_subscription_ref is not null
           and (status = 'past_due' or (current_period_end is not null and current_period_end < now() + interval '1 day') )
           and (last_reconciled_at is null or last_reconciled_at < now() - interval '6 hours') order by last_reconciled_at nulls first limit least(greatest(p_limit, 1), 200)) s $$;

create or replace function public.billing_svc_subscription(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) from public.subscriptions s where org_id = p_org $$;

-- Operator action: assign a plan by hand (invoice customers, pilots, corrections). Always recorded.
create or replace function public.billing_svc_assign(p_org uuid, p_plan text, p_status text, p_period_end timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  if not exists (select 1 from public.plans where code = p_plan) then raise exception 'unknown plan' using errcode = 'PT404'; end if;
  if p_status not in ('trialing', 'active', 'past_due', 'cancelled', 'expired') then raise exception 'invalid status' using errcode = 'PT422'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'a reason is required' using errcode = 'PT422'; end if;
  select * into s from public.subscriptions where org_id = p_org for update;
  if s.id is null then raise exception 'organization not found' using errcode = 'PT404'; end if;
  update public.subscriptions set plan_code = p_plan, status = p_status, provider = case when provider = 'manual' then 'manual' else provider end,
    current_period_end = p_period_end, trial_ends_at = case when p_status = 'trialing' then coalesce(p_period_end, now() + interval '14 days') else trial_ends_at end,
    grace_until = case when p_status = 'past_due' then coalesce(grace_until, now() + interval '7 days') else null end,
    cancel_at_period_end = false, cancelled_at = case when p_status = 'cancelled' then now() end where org_id = p_org;
  perform app.sub_log(p_org, 'assigned_by_operator', s.status, p_status, p_plan, 'manual', null, jsonb_build_object('reason', left(p_reason, 300), 'period_end', p_period_end));
  perform app.notify_role(p_org, 'admin', 'billing.plan_changed', 'Your plan is now ' || app.plan_name(p_plan), 'Updated by our team.', '/app?org=' || p_org || '#/billing', 'billing:assign:' || extract(epoch from now())::bigint);
  return public.billing_svc_subscription(p_org);
end $$;

create or replace function public.billing_svc_set_override(p_org uuid, p_key text, p_enabled boolean, p_limit bigint, p_reason text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.entitlement_catalog where key = p_key) then raise exception 'unknown entitlement' using errcode = 'PT404'; end if;
  insert into public.org_entitlement_overrides (org_id, key, enabled, limit_value, reason, expires_at) values (p_org, p_key, coalesce(p_enabled, true), p_limit, p_reason, p_expires_at)
  on conflict (org_id, key) do update set enabled = excluded.enabled, limit_value = excluded.limit_value, reason = excluded.reason, expires_at = excluded.expires_at, created_at = now();
  perform app.sub_log(p_org, 'override_set', null, null, null, 'manual', null, jsonb_build_object('key', p_key, 'limit', p_limit, 'enabled', p_enabled, 'reason', left(p_reason, 200)));
  return app.ent(p_org, p_key);
end $$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as f, p.proname as pn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'billing\_svc\_%' or p.proname in ('get_entitlements', 'require_entitlement', 'get_billing', 'begin_checkout')) loop
    execute format('revoke execute on function %s from public, anon', r.f);
    if r.pn like 'billing\_svc\_%' then execute format('revoke execute on function %s from authenticated', r.f); execute format('grant execute on function %s to service_role', r.f);
    else execute format('grant execute on function %s to authenticated', r.f); end if;
  end loop;
end $$;
