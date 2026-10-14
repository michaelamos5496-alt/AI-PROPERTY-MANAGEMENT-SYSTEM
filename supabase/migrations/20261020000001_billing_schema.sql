-- Phase 7: plans, entitlements, subscriptions, usage, and the enforcement that sits INSIDE the database.
-- Limits are checked by triggers and functions, so every path (API, background job, future code) is held to them. Hiding a button is never the control.
-- Principle: a lapsed or cancelled subscription never deletes or locks away data. It only stops NEW additions beyond the fallback plan's limits.

create table if not exists public.entitlement_catalog (
  key        text primary key check (key ~ '^[a-z_]{2,40}$'),
  kind       text not null check (kind in ('limit', 'feature')),
  label      text not null,
  unit       text,                                                  -- shown after the number: 'properties', 'MB', 'per month'…
  metered    boolean not null default false,                        -- true: a monthly counter; false: counted live from the data
  sort       int not null default 100
);

create table if not exists public.plans (
  code         text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name         text not null check (char_length(name) between 2 and 60),
  description  text check (char_length(description) <= 300),
  public       boolean not null default true,                       -- offered for self-service checkout
  active       boolean not null default true,
  trial_days   int not null default 0 check (trial_days between 0 and 90),
  sort         int not null default 100,
  created_at   timestamptz not null default now()
);

-- enabled=false → not included. limit_value null with enabled=true → unlimited. Absent row → not included.
create table if not exists public.plan_entitlements (
  plan_code    text not null references public.plans (code) on delete cascade,
  key          text not null references public.entitlement_catalog (key),
  enabled      boolean not null default true,
  limit_value  bigint check (limit_value is null or limit_value >= 0),
  primary key (plan_code, key)
);

-- Prices per currency and billing interval. provider_plan_ref is the id of the matching plan at the billing provider (set when you create it there).
create table if not exists public.plan_prices (
  id                bigint generated always as identity primary key,
  plan_code         text not null references public.plans (code) on delete cascade,
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  interval          text not null check (interval in ('monthly', 'annual')),
  amount_minor      bigint not null check (amount_minor > 0),
  provider          text not null default 'paystack' check (provider in ('paystack', 'manual')),
  provider_plan_ref text,
  active            boolean not null default true,
  unique (plan_code, currency, interval, provider)
);

create table if not exists public.billing_config (
  id                  boolean primary key default true check (id),
  default_trial_plan  text not null references public.plans (code),
  fallback_plan       text not null references public.plans (code),   -- what an organization gets when nothing is paid up
  trial_days          int not null default 14 check (trial_days between 0 and 90),
  grace_days          int not null default 7 check (grace_days between 0 and 60)
);

create table if not exists public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null unique references public.organizations (id) on delete restrict,
  plan_code                 text not null references public.plans (code),
  status                    text not null check (status in ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  provider                  text not null default 'manual' check (provider in ('manual', 'paystack')),
  provider_customer_ref     text,
  provider_subscription_ref text,
  currency                  char(3),
  interval                  text check (interval in ('monthly', 'annual')),
  trial_ends_at             timestamptz,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean not null default false,
  cancelled_at              timestamptz,
  grace_until               timestamptz,
  last_payment_at           timestamptz,
  last_failure_at           timestamptz,
  last_reconciled_at        timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists subscriptions_provider_idx on public.subscriptions (provider, provider_subscription_ref) where provider_subscription_ref is not null;
create index if not exists subscriptions_customer_idx on public.subscriptions (provider, provider_customer_ref) where provider_customer_ref is not null;

-- What happened to a subscription, in order. Append-only.
create table if not exists public.subscription_events (
  id                bigint generated always as identity primary key,
  org_id            uuid not null references public.organizations (id) on delete restrict,
  type              text not null check (char_length(type) <= 60),
  from_status       text,
  to_status         text,
  plan_code         text,
  provider          text,
  provider_event_id text,
  detail            jsonb not null default '{}',
  created_at        timestamptz not null default now()
);
create index if not exists subscription_events_org_idx on public.subscription_events (org_id, id desc);

-- Checkout attempts we started. A payment is attributed to an organization ONLY through one of these (or a stored provider reference),
-- never through anything a browser says.
create table if not exists public.billing_checkouts (
  reference   text primary key check (char_length(reference) between 8 and 100),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  plan_code   text not null references public.plans (code),
  interval    text not null check (interval in ('monthly', 'annual')),
  currency    char(3) not null,
  provider    text not null,
  amount_minor bigint not null,
  status      text not null default 'initiated' check (status in ('initiated', 'paid', 'rejected')),
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now()
);
create index if not exists billing_checkouts_org_idx on public.billing_checkouts (org_id, created_at desc);

-- Webhook inbox: one row per provider event (unique on a stable id derived from it), verified before it gets here.
create table if not exists public.billing_events (
  id                bigint generated always as identity primary key,
  provider          text not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 300),
  type              text not null check (char_length(type) <= 80),
  payload           jsonb not null,
  normalized        jsonb not null,
  org_id            uuid references public.organizations (id) on delete restrict,
  status            text not null default 'pending' check (status in ('pending', 'processed', 'ignored', 'rejected')),
  attempts          int not null default 0,
  error             text check (char_length(error) <= 500),
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  unique (provider, provider_event_id)
);
create index if not exists billing_events_pending_idx on public.billing_events (id) where status = 'pending';

create table if not exists public.usage_counters (
  org_id  uuid not null references public.organizations (id) on delete cascade,
  key     text not null references public.entitlement_catalog (key),
  period  date not null,                       -- first day of the UTC month
  used    bigint not null default 0 check (used >= 0),
  primary key (org_id, key, period)
);

-- Operator-granted exceptions (support gestures, pilots). Trusted: written only with the service role.
create table if not exists public.org_entitlement_overrides (
  org_id       uuid not null references public.organizations (id) on delete cascade,
  key          text not null references public.entitlement_catalog (key),
  enabled      boolean not null default true,
  limit_value  bigint check (limit_value is null or limit_value >= 0),
  reason       text not null check (char_length(reason) between 3 and 300),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (org_id, key)
);

-- ---------------------------------------------------------------- seed (trusted configuration)
insert into public.entitlement_catalog (key, kind, label, unit, metered, sort) values
  ('properties', 'limit', 'Properties', 'properties', false, 10),
  ('units', 'limit', 'Units', 'units', false, 20),
  ('seats', 'limit', 'Team seats (excluding view-only members)', 'seats', false, 30),
  ('storage_mb', 'limit', 'Document storage', 'MB', false, 40),
  ('ai_requests_month', 'limit', 'AI copilot requests', 'per month', true, 50),
  ('whatsapp_conversations_month', 'limit', 'WhatsApp conversations', 'per month', true, 60),
  ('copilot', 'feature', 'AI copilot', null, false, 70),
  ('whatsapp', 'feature', 'WhatsApp tenant assistant', null, false, 80),
  ('exports', 'feature', 'Data exports (CSV)', null, false, 90)
on conflict (key) do nothing;

insert into public.plans (code, name, description, public, trial_days, sort) values
  ('free', 'Free', 'What an organization keeps when nothing is paid up. Existing data stays; new additions are limited.', false, 0, 0),
  ('starter', 'Starter', 'For a small portfolio.', true, 0, 10),
  ('growth', 'Growth', 'For a growing portfolio: WhatsApp assistant, more AI and exports.', true, 14, 20),
  ('scale', 'Scale', 'For large portfolios and bigger teams.', true, 0, 30),
  ('legacy', 'Legacy (unlimited)', 'Organizations that existed before plans were introduced. Not offered.', false, 0, 99)
on conflict (code) do nothing;

-- limits: [properties, units, seats, storage_mb, ai_requests_month, whatsapp_conversations_month]; null = unlimited
insert into public.plan_entitlements (plan_code, key, enabled, limit_value)
select p, k, (l is null or l > 0 or f), l from (values
  ('free', 'properties', 1::bigint, false), ('free', 'units', 5, false), ('free', 'seats', 2, false), ('free', 'storage_mb', 100, false), ('free', 'ai_requests_month', 0, false), ('free', 'whatsapp_conversations_month', 0, false),
  ('starter', 'properties', 3, false), ('starter', 'units', 30, false), ('starter', 'seats', 3, false), ('starter', 'storage_mb', 1000, false), ('starter', 'ai_requests_month', 100, false), ('starter', 'whatsapp_conversations_month', 0, false),
  ('growth', 'properties', 25, false), ('growth', 'units', 500, false), ('growth', 'seats', 10, false), ('growth', 'storage_mb', 10000, false), ('growth', 'ai_requests_month', 2000, false), ('growth', 'whatsapp_conversations_month', 1000, false),
  ('scale', 'properties', 250, false), ('scale', 'units', 5000, false), ('scale', 'seats', 50, false), ('scale', 'storage_mb', 100000, false), ('scale', 'ai_requests_month', 20000, false), ('scale', 'whatsapp_conversations_month', 10000, false),
  ('legacy', 'properties', null, true), ('legacy', 'units', null, true), ('legacy', 'seats', null, true), ('legacy', 'storage_mb', null, true), ('legacy', 'ai_requests_month', null, true), ('legacy', 'whatsapp_conversations_month', null, true)
) v(p, k, l, f)
on conflict (plan_code, key) do nothing;
-- features
insert into public.plan_entitlements (plan_code, key, enabled)
select p, k, e from (values
  ('free', 'copilot', false), ('free', 'whatsapp', false), ('free', 'exports', false),
  ('starter', 'copilot', true), ('starter', 'whatsapp', false), ('starter', 'exports', false),
  ('growth', 'copilot', true), ('growth', 'whatsapp', true), ('growth', 'exports', true),
  ('scale', 'copilot', true), ('scale', 'whatsapp', true), ('scale', 'exports', true),
  ('legacy', 'copilot', true), ('legacy', 'whatsapp', true), ('legacy', 'exports', true)
) v(p, k, e)
on conflict (plan_code, key) do nothing;

-- PLACEHOLDER PRICES. They exist so the system is testable end to end; set your real prices (and the provider's plan codes) before launch.
-- A currency here is NOT a promise that a billing provider can charge in it: checkout also requires the provider to be enabled for that currency.
insert into public.plan_prices (plan_code, currency, interval, amount_minor, provider) values
  ('starter', 'NGN', 'monthly', 1500000, 'paystack'), ('starter', 'GHS', 'monthly', 15000, 'paystack'), ('starter', 'KES', 'monthly', 150000, 'paystack'), ('starter', 'USD', 'monthly', 1900, 'paystack'),
  ('growth', 'NGN', 'monthly', 4500000, 'paystack'), ('growth', 'GHS', 'monthly', 45000, 'paystack'), ('growth', 'KES', 'monthly', 450000, 'paystack'), ('growth', 'USD', 'monthly', 4900, 'paystack'),
  ('growth', 'NGN', 'annual', 45000000, 'paystack'), ('growth', 'USD', 'annual', 49000, 'paystack'),
  ('scale', 'NGN', 'monthly', 15000000, 'paystack'), ('scale', 'GHS', 'monthly', 150000, 'paystack'), ('scale', 'KES', 'monthly', 1500000, 'paystack'), ('scale', 'USD', 'monthly', 14900, 'paystack')
on conflict do nothing;

insert into public.billing_config (id, default_trial_plan, fallback_plan, trial_days, grace_days) values (true, 'growth', 'free', 14, 7) on conflict (id) do nothing;

insert into public.notification_event_types (event_type, label, default_email, default_in_app, mandatory) values
  ('billing.trial_ending', 'Trial ending soon', true, true, false),
  ('billing.past_due', 'Payment failed', true, true, true),
  ('billing.plan_changed', 'Subscription changed', true, true, false)
on conflict (event_type) do nothing;

-- ---------------------------------------------------------------- lookups
create or replace function app.billing_cfg() returns public.billing_config
language sql stable security definer set search_path = '' as $$ select * from public.billing_config where id $$;

-- Which plan applies to this organization right now.
create or replace function app.effective_plan(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when s.status = 'trialing' and s.trial_ends_at > now() then s.plan_code
      when s.status = 'active' and (s.current_period_end is null or s.current_period_end + interval '1 day' > now()) then s.plan_code   -- a day's tolerance for a late renewal notice
      when s.status = 'past_due' and coalesce(s.grace_until, '-infinity') > now() then s.plan_code
      when s.status = 'cancelled' and s.current_period_end > now() then s.plan_code                                                    -- paid through the end of the period
    end from public.subscriptions s where s.org_id = p_org), (select fallback_plan from public.billing_config where id)) $$;

-- {enabled, limit, plan, source}. Operator overrides win; a missing row means "not included".
create or replace function app.ent(p_org uuid, p_key text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.org_entitlement_overrides; e public.plan_entitlements; v_plan text := app.effective_plan(p_org);
begin
  select * into o from public.org_entitlement_overrides where org_id = p_org and key = p_key and (expires_at is null or expires_at > now());
  if o.org_id is not null then return jsonb_build_object('enabled', o.enabled, 'limit', o.limit_value, 'plan', v_plan, 'source', 'override'); end if;
  select * into e from public.plan_entitlements where plan_code = v_plan and key = p_key;
  if e.plan_code is null then return jsonb_build_object('enabled', false, 'limit', 0, 'plan', v_plan, 'source', 'plan'); end if;
  return jsonb_build_object('enabled', e.enabled, 'limit', e.limit_value, 'plan', v_plan, 'source', 'plan');
end $$;

create or replace function app.plan_name(p_code text) returns text
language sql stable security definer set search_path = '' as $$ select coalesce((select name from public.plans where code = p_code), p_code) $$;

-- Serialise concurrent additions for one organization and key, so two requests cannot both squeeze under the limit.
create or replace function app.lock_ent(p_org uuid, p_key text) returns void
language sql security definer set search_path = '' as $$ select pg_advisory_xact_lock(hashtextextended('ent:' || p_org || ':' || p_key, 0)) $$;

create or replace function app.check_limit(p_org uuid, p_key text, p_total bigint, p_what text) returns void
language plpgsql security definer set search_path = '' as $$
declare e jsonb := app.ent(p_org, p_key);
begin
  if not (e ->> 'enabled')::boolean or ((e ->> 'limit') is not null and p_total > (e ->> 'limit')::bigint) then
    raise exception 'Your % plan allows %. Upgrade your plan to add more.', app.plan_name(e ->> 'plan'),
      case when not (e ->> 'enabled')::boolean then 'no ' || p_what else (e ->> 'limit') || ' ' || p_what end using errcode = 'PT402';
  end if;
end $$;

create or replace function app.require_feature(p_org uuid, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare e jsonb := app.ent(p_org, p_key);
begin
  if not (e ->> 'enabled')::boolean then
    raise exception 'This is not included in your % plan. Upgrade to use % .', app.plan_name(e ->> 'plan'), coalesce((select label from public.entitlement_catalog where key = p_key), p_key) using errcode = 'PT402';
  end if;
end $$;

-- Monthly meters (UTC months). Atomic: the check and the increment happen under one lock.
create or replace function app.consume(p_org uuid, p_key text, p_n bigint default 1) returns bigint
language plpgsql security definer set search_path = '' as $$
declare e jsonb := app.ent(p_org, p_key); v_used bigint; v_period date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  perform app.lock_ent(p_org, p_key);
  select used into v_used from public.usage_counters where org_id = p_org and key = p_key and period = v_period;
  if not (e ->> 'enabled')::boolean or ((e ->> 'limit') is not null and coalesce(v_used, 0) + p_n > (e ->> 'limit')::bigint) then
    raise exception 'You have used all % of your % allowance for this month on the % plan. It resets next month, or upgrade for more.', coalesce(e ->> 'limit', '0'),
      lower(coalesce((select label from public.entitlement_catalog where key = p_key), p_key)), app.plan_name(e ->> 'plan') using errcode = 'PT402';
  end if;
  insert into public.usage_counters (org_id, key, period, used) values (p_org, p_key, v_period, p_n)
  on conflict (org_id, key, period) do update set used = public.usage_counters.used + p_n returning used into v_used;
  return v_used;
end $$;

create or replace function app.usage_now(p_org uuid, p_key text) returns bigint
language sql stable security definer set search_path = '' as $$
  select case p_key
    when 'properties' then (select count(*) from public.properties where org_id = p_org and archived_at is null)
    when 'units' then (select count(*) from public.units where org_id = p_org and archived_at is null)
    when 'seats' then (select count(*) from public.memberships where org_id = p_org and role <> 'viewer')
    when 'storage_mb' then (select ceil(coalesce(sum(b), 0) / 1048576.0)::bigint from (
        select size_bytes b from public.lease_documents where org_id = p_org and archived_at is null
        union all select size_bytes from public.maintenance_attachments where org_id = p_org and archived_at is null) x)
    else (select coalesce(used, 0) from public.usage_counters where org_id = p_org and key = p_key and period = date_trunc('month', now() at time zone 'UTC')::date) end $$;

-- ---------------------------------------------------------------- enforcement triggers
create or replace function app.trg_limit_properties() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then
    perform app.lock_ent(new.org_id, 'properties');
    perform app.check_limit(new.org_id, 'properties', (select count(*) from public.properties where org_id = new.org_id and archived_at is null) + 1, 'properties');
  end if;
  return new;
end $$;
drop trigger if exists properties_limit on public.properties;
create trigger properties_limit before insert or update of archived_at on public.properties for each row execute function app.trg_limit_properties();

create or replace function app.trg_limit_units() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then
    perform app.lock_ent(new.org_id, 'units');
    perform app.check_limit(new.org_id, 'units', (select count(*) from public.units where org_id = new.org_id and archived_at is null) + 1, 'units');
  end if;
  return new;
end $$;
drop trigger if exists units_limit on public.units;
create trigger units_limit before insert or update of archived_at on public.units for each row execute function app.trg_limit_units();

-- Seats are people who can do work. View-only members are free.
create or replace function app.trg_limit_seats() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role <> 'viewer' and (tg_op = 'INSERT' or old.role = 'viewer') then
    perform app.lock_ent(new.org_id, 'seats');
    perform app.check_limit(new.org_id, 'seats', (select count(*) from public.memberships where org_id = new.org_id and role <> 'viewer') + 1, 'team seats');
  end if;
  return new;
end $$;
drop trigger if exists memberships_limit on public.memberships;
create trigger memberships_limit before insert or update of role on public.memberships for each row execute function app.trg_limit_seats();

-- An invitation reserves a seat, so a plan cannot be oversubscribed by inviting first and accepting later.
create or replace function app.trg_limit_invites() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role <> 'viewer' and new.accepted_at is null and new.revoked_at is null then
    perform app.lock_ent(new.org_id, 'seats');
    perform app.check_limit(new.org_id, 'seats',
      (select count(*) from public.memberships where org_id = new.org_id and role <> 'viewer')
      + (select count(*) from public.invitations where org_id = new.org_id and role <> 'viewer' and accepted_at is null and revoked_at is null and expires_at > now()) + 1, 'team seats');
  end if;
  return new;
end $$;
drop trigger if exists invitations_limit on public.invitations;
create trigger invitations_limit before insert on public.invitations for each row execute function app.trg_limit_invites();

create or replace function app.trg_limit_storage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_now bigint;
begin
  if new.archived_at is null and (tg_op = 'INSERT' or new.size_bytes > old.size_bytes) then
    perform app.lock_ent(new.org_id, 'storage_mb');
    select coalesce(sum(b), 0) into v_now from (select size_bytes b from public.lease_documents where org_id = new.org_id and archived_at is null and id is distinct from new.id
        union all select size_bytes from public.maintenance_attachments where org_id = new.org_id and archived_at is null and id is distinct from new.id) x;
    perform app.check_limit(new.org_id, 'storage_mb', ceil((v_now + new.size_bytes) / 1048576.0)::bigint, 'MB of document storage');
  end if;
  return new;
end $$;
drop trigger if exists lease_documents_limit on public.lease_documents;
create trigger lease_documents_limit before insert or update of size_bytes on public.lease_documents for each row execute function app.trg_limit_storage();
drop trigger if exists maintenance_attachments_limit on public.maintenance_attachments;
create trigger maintenance_attachments_limit before insert or update of size_bytes on public.maintenance_attachments for each row execute function app.trg_limit_storage();

-- ---------------------------------------------------------------- every organization gets a subscription
create or replace function app.sub_log(p_org uuid, p_type text, p_from text, p_to text, p_plan text, p_provider text, p_event text, p_detail jsonb default '{}') returns void
language sql security definer set search_path = '' as $$
  insert into public.subscription_events (org_id, type, from_status, to_status, plan_code, provider, provider_event_id, detail) values (p_org, p_type, p_from, p_to, p_plan, p_provider, p_event, coalesce(p_detail, '{}')) $$;

create or replace function app.trg_start_trial() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.billing_config := app.billing_cfg();
begin
  insert into public.subscriptions (org_id, plan_code, status, trial_ends_at)
  values (new.id, c.default_trial_plan, case when c.trial_days > 0 then 'trialing' else 'expired' end, now() + make_interval(days => c.trial_days)) on conflict (org_id) do nothing;
  perform app.sub_log(new.id, 'trial_started', null, 'trialing', c.default_trial_plan, 'manual', null, jsonb_build_object('days', c.trial_days));
  return new;
end $$;
drop trigger if exists organizations_trial on public.organizations;
create trigger organizations_trial after insert on public.organizations for each row execute function app.trg_start_trial();

-- Organizations that already existed keep everything (the unlimited "legacy" plan) until an operator moves them.
insert into public.subscriptions (org_id, plan_code, status, provider)
select o.id, 'legacy', 'active', 'manual' from public.organizations o where not exists (select 1 from public.subscriptions s where s.org_id = o.id);

drop trigger if exists subscription_events_guard on public.subscription_events;
create trigger subscription_events_guard before update or delete on public.subscription_events for each row execute function app.finance_guard();
drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- access
revoke all on public.entitlement_catalog, public.plans, public.plan_entitlements, public.plan_prices, public.billing_config, public.subscriptions, public.subscription_events,
  public.billing_checkouts, public.billing_events, public.usage_counters, public.org_entitlement_overrides from anon, authenticated;
grant select on public.entitlement_catalog, public.plans, public.plan_entitlements, public.plan_prices, public.subscriptions, public.subscription_events, public.usage_counters, public.org_entitlement_overrides to authenticated;
do $$ declare t text; begin
  foreach t in array array['entitlement_catalog', 'plans', 'plan_entitlements', 'plan_prices', 'billing_config', 'subscriptions', 'subscription_events', 'billing_checkouts', 'billing_events', 'usage_counters', 'org_entitlement_overrides'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
drop policy if exists catalog_read on public.entitlement_catalog; create policy catalog_read on public.entitlement_catalog for select to authenticated using (true);
drop policy if exists plans_read on public.plans; create policy plans_read on public.plans for select to authenticated using (active);
drop policy if exists plan_ent_read on public.plan_entitlements; create policy plan_ent_read on public.plan_entitlements for select to authenticated using (true);
drop policy if exists plan_prices_read on public.plan_prices; create policy plan_prices_read on public.plan_prices for select to authenticated using (active);
drop policy if exists subs_read on public.subscriptions; create policy subs_read on public.subscriptions for select to authenticated using (app.has_role(org_id, 'admin'));
drop policy if exists sub_events_read on public.subscription_events; create policy sub_events_read on public.subscription_events for select to authenticated using (app.has_role(org_id, 'admin'));
drop policy if exists usage_read on public.usage_counters; create policy usage_read on public.usage_counters for select to authenticated using (app.has_role(org_id, 'admin'));
drop policy if exists overrides_read on public.org_entitlement_overrides; create policy overrides_read on public.org_entitlement_overrides for select to authenticated using (app.has_role(org_id, 'admin'));
