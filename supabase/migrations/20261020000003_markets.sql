-- Phase 7: country and organization settings. Reference data (ISO 3166, ISO 4217, IANA time zones, ITU calling codes) is configuration here,
-- not law. Country-specific LEGAL or tenancy rules are never built in: they live in rule packs that stay inert until a qualified person has reviewed them.

create table if not exists public.currencies (
  code      char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name      text not null,
  exponent  smallint not null check (exponent between 0 and 3),       -- ISO 4217 minor-unit digits
  symbol    text
);
insert into public.currencies (code, name, exponent, symbol) values
  ('GHS', 'Ghanaian cedi', 2, 'GH₵'), ('NGN', 'Nigerian naira', 2, '₦'), ('KES', 'Kenyan shilling', 2, 'KSh'), ('ZAR', 'South African rand', 2, 'R'),
  ('UGX', 'Ugandan shilling', 0, 'USh'), ('TZS', 'Tanzanian shilling', 2, 'TSh'), ('RWF', 'Rwandan franc', 0, 'RF'), ('XOF', 'West African CFA franc', 0, 'CFA'), ('XAF', 'Central African CFA franc', 0, 'FCFA'),
  ('EGP', 'Egyptian pound', 2, 'E£'), ('MAD', 'Moroccan dirham', 2, 'MAD'), ('ETB', 'Ethiopian birr', 2, 'Br'), ('ZMW', 'Zambian kwacha', 2, 'ZK'), ('BWP', 'Botswana pula', 2, 'P'), ('MUR', 'Mauritian rupee', 2, '₨'),
  ('USD', 'US dollar', 2, '$'), ('EUR', 'Euro', 2, '€'), ('GBP', 'Pound sterling', 2, '£'), ('CAD', 'Canadian dollar', 2, '$'), ('AUD', 'Australian dollar', 2, '$'), ('NZD', 'New Zealand dollar', 2, '$'),
  ('CHF', 'Swiss franc', 2, 'CHF'), ('SEK', 'Swedish krona', 2, 'kr'), ('NOK', 'Norwegian krone', 2, 'kr'), ('DKK', 'Danish krone', 2, 'kr'), ('PLN', 'Polish zloty', 2, 'zł'), ('CZK', 'Czech koruna', 2, 'Kč'),
  ('INR', 'Indian rupee', 2, '₹'), ('JPY', 'Japanese yen', 0, '¥'), ('CNY', 'Chinese yuan', 2, '¥'), ('KRW', 'South Korean won', 0, '₩'), ('SGD', 'Singapore dollar', 2, '$'), ('HKD', 'Hong Kong dollar', 2, '$'),
  ('AED', 'UAE dirham', 2, 'AED'), ('SAR', 'Saudi riyal', 2, 'SAR'), ('KWD', 'Kuwaiti dinar', 3, 'KD'), ('BHD', 'Bahraini dinar', 3, 'BD'), ('OMR', 'Omani rial', 3, 'OMR'), ('JOD', 'Jordanian dinar', 3, 'JD'), ('TND', 'Tunisian dinar', 3, 'DT'),
  ('BRL', 'Brazilian real', 2, 'R$'), ('MXN', 'Mexican peso', 2, '$'), ('ARS', 'Argentine peso', 2, '$'), ('CLP', 'Chilean peso', 0, '$'), ('COP', 'Colombian peso', 2, '$'), ('TRY', 'Turkish lira', 2, '₺'), ('ILS', 'Israeli shekel', 2, '₪'),
  ('VND', 'Vietnamese dong', 0, '₫'), ('ISK', 'Icelandic króna', 0, 'kr'), ('THB', 'Thai baht', 2, '฿'), ('MYR', 'Malaysian ringgit', 2, 'RM'), ('IDR', 'Indonesian rupiah', 2, 'Rp'), ('PHP', 'Philippine peso', 2, '₱'), ('PKR', 'Pakistani rupee', 2, '₨')
on conflict (code) do nothing;

-- Payment providers an organization may list for its own use. This is a registry of NAMES; whether a provider can settle a currency in a
-- country is for that provider (and your account with them) to say, and is checked where money would actually move.
create table if not exists public.payment_provider_registry (
  code    text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name    text not null,
  kind    text not null check (kind in ('card_gateway', 'mobile_money', 'bank_transfer', 'cash', 'other')),
  status  text not null default 'planned' check (status in ('planned', 'enabled')),
  note    text
);
insert into public.payment_provider_registry (code, name, kind, status, note) values
  ('manual_bank_transfer', 'Bank transfer (recorded manually)', 'bank_transfer', 'enabled', 'Payments are recorded by staff; nothing is collected through the app.'),
  ('manual_cash', 'Cash (recorded manually)', 'cash', 'enabled', null),
  ('manual_mobile_money', 'Mobile money (recorded manually)', 'mobile_money', 'enabled', 'For example M-Pesa or MTN MoMo payments entered by staff. No integration.'),
  ('paystack', 'Paystack', 'card_gateway', 'planned', 'Used for app subscriptions; rent collection through it is not built.'),
  ('flutterwave', 'Flutterwave', 'card_gateway', 'planned', 'Not integrated.')
on conflict (code) do nothing;

create table if not exists public.country_profiles (
  iso2              char(2) primary key check (iso2 ~ '^[A-Z]{2}$'),
  name              text not null,
  calling_code      text not null check (calling_code ~ '^[0-9]{1,4}$'),
  trunk_prefix      text,                                            -- national dialling prefix dropped in international format (e.g. 0)
  default_currency  char(3) not null references public.currencies (code),
  currencies        char(3)[] not null default '{}',
  default_timezone  text not null,
  timezones         text[] not null default '{}',
  default_locale    text not null check (default_locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  date_format       text not null check (date_format in ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  comms             jsonb not null default '{}',
  note              text
);
insert into public.country_profiles (iso2, name, calling_code, trunk_prefix, default_currency, currencies, default_timezone, timezones, default_locale, date_format, comms, note) values
  ('GH', 'Ghana', '233', '0', 'GHS', '{GHS,USD}', 'Africa/Accra', '{Africa/Accra}', 'en-GH', 'DD/MM/YYYY', '{"preferred_channels":["whatsapp","sms","email"],"quiet_hours":{"start":"21:00","end":"07:00"},"languages":["en"]}', 'Reference data only. No Ghana-specific legal or tenancy rules are built in.'),
  ('NG', 'Nigeria', '234', '0', 'NGN', '{NGN,USD}', 'Africa/Lagos', '{Africa/Lagos}', 'en-NG', 'DD/MM/YYYY', '{"preferred_channels":["whatsapp","sms","email"],"quiet_hours":{"start":"21:00","end":"07:00"},"languages":["en"]}', 'Reference data only. No Nigeria-specific legal or tenancy rules are built in.'),
  ('KE', 'Kenya', '254', '0', 'KES', '{KES,USD}', 'Africa/Nairobi', '{Africa/Nairobi}', 'en-KE', 'DD/MM/YYYY', '{"preferred_channels":["whatsapp","sms","email"],"quiet_hours":{"start":"21:00","end":"07:00"},"languages":["en","sw"]}', 'Reference data only. No Kenya-specific legal or tenancy rules are built in.'),
  ('ZA', 'South Africa', '27', '0', 'ZAR', '{ZAR,USD}', 'Africa/Johannesburg', '{Africa/Johannesburg}', 'en-ZA', 'YYYY-MM-DD', '{"preferred_channels":["whatsapp","email"],"languages":["en"]}', 'Reference data only.'),
  ('US', 'United States', '1', '1', 'USD', '{USD}', 'America/Chicago', '{America/New_York,America/Chicago,America/Denver,America/Los_Angeles}', 'en-US', 'MM/DD/YYYY', '{"preferred_channels":["email","sms"],"languages":["en"]}', 'Reference data only.')
on conflict (iso2) do nothing;

create table if not exists public.org_settings (
  org_id            uuid primary key references public.organizations (id) on delete cascade,
  country           char(2) references public.country_profiles (iso2),
  base_currency     char(3) references public.currencies (code),
  timezone          text,
  locale            text check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  date_format       text check (date_format in ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  payment_providers text[] not null default '{}',
  comms             jsonb not null default '{}',
  rule_packs        text[] not null default '{}',                    -- enabled pack ids, 'GH:code'; each must exist and be reviewed
  updated_by        uuid references auth.users (id),
  updated_at        timestamptz not null default now()
);

-- THE extension point for country-specific rules. Nothing is shipped. A pack is inert until status = 'reviewed' by a named, qualified reviewer.
create table if not exists public.country_rule_packs (
  id           bigint generated always as identity primary key,
  country      char(2) not null references public.country_profiles (iso2),
  code         text not null check (code ~ '^[a-z][a-z0-9_-]{1,40}$'),
  version      int not null default 1,
  title        text not null,
  status       text not null default 'draft' check (status in ('draft', 'under_review', 'reviewed', 'retired')),
  reviewer     text,
  reviewed_at  timestamptz,
  review_note  text,
  content      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  unique (country, code, version),
  check (status <> 'reviewed' or (reviewer is not null and char_length(btrim(reviewer)) >= 3 and reviewed_at is not null and char_length(btrim(coalesce(review_note, ''))) >= 10))
);

-- Currencies must be real ISO 4217 codes we know how to format. (Existing properties are unaffected: this checks new and changed values.)
create or replace function app.trg_known_currency() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.currencies where code = new.currency) then raise exception 'unsupported currency %', new.currency using errcode = 'PT422'; end if;
  return new;
end $$;
drop trigger if exists properties_currency on public.properties;
create trigger properties_currency before insert or update of currency on public.properties for each row execute function app.trg_known_currency();

-- ------------------------------------------------------------------ functions
create or replace function app.valid_timezone(p text) returns boolean
language plpgsql stable set search_path = '' as $$
begin perform now() at time zone p; return p is not null and exists (select 1 from pg_timezone_names where name = p); exception when others then return false; end $$;

-- The organization's effective settings: its own choices, falling back to its country's defaults.
create or replace function app.market(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('country', s.country, 'currency', coalesce(s.base_currency, c.default_currency), 'timezone', coalesce(s.timezone, c.default_timezone), 'locale', coalesce(s.locale, c.default_locale),
    'date_format', coalesce(s.date_format, c.date_format), 'calling_code', c.calling_code, 'trunk_prefix', c.trunk_prefix, 'payment_providers', coalesce(s.payment_providers, '{}'),
    'comms', coalesce(c.comms, '{}'::jsonb) || coalesce(s.comms, '{}'::jsonb), 'rule_packs', coalesce(s.rule_packs, '{}'), 'configured', s.org_id is not null)
  from (select 1) d left join public.org_settings s on s.org_id = p_org left join public.country_profiles c on c.iso2 = s.country $$;

create or replace function app.org_tz(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(s.timezone, c.default_timezone) from public.org_settings s left join public.country_profiles c on c.iso2 = s.country where s.org_id = p_org $$;

create or replace function public.get_market(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'viewer');
  return app.market(p_org) || jsonb_build_object(
    'countries', (select coalesce(jsonb_agg(jsonb_build_object('iso2', iso2, 'name', name, 'calling_code', calling_code, 'default_currency', default_currency, 'currencies', currencies, 'default_timezone', default_timezone,
        'timezones', timezones, 'default_locale', default_locale, 'date_format', date_format, 'note', note) order by name), '[]'::jsonb) from public.country_profiles),
    'currencies', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'exponent', exponent, 'symbol', symbol) order by code), '[]'::jsonb) from public.currencies),
    'payment_provider_options', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'kind', kind, 'status', status, 'note', note) order by code), '[]'::jsonb) from public.payment_provider_registry),
    'rule_pack_options', (select coalesce(jsonb_agg(jsonb_build_object('id', country || ':' || code, 'title', title, 'version', version) order by country, code), '[]'::jsonb)
        from public.country_rule_packs rp where rp.status = 'reviewed' and rp.country = (select country from public.org_settings where org_id = p_org)));
end $$;

create or replace function public.save_market(p_org uuid, p_country text, p_currency text, p_timezone text, p_locale text, p_date_format text, p_payment_providers jsonb, p_comms jsonb, p_rule_packs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_prov text[]; v_packs text[]; v_pack text; v_ch jsonb; v_q jsonb;
begin
  perform app.require_role(p_org, 'admin');
  if p_country is not null and not exists (select 1 from public.country_profiles where iso2 = upper(p_country)) then raise exception 'country % is not configured', p_country using errcode = 'PT422'; end if;
  if p_currency is not null and not exists (select 1 from public.currencies where code = upper(p_currency)) then raise exception 'currency % is not supported', p_currency using errcode = 'PT422'; end if;
  if p_timezone is not null and not app.valid_timezone(p_timezone) then raise exception '% is not an IANA time zone', p_timezone using errcode = 'PT422'; end if;
  v_prov := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p_payment_providers, '[]'::jsonb)) x), '{}');
  if exists (select 1 from unnest(v_prov) x where not exists (select 1 from public.payment_provider_registry where code = x)) then raise exception 'unknown payment provider' using errcode = 'PT422'; end if;
  v_ch := coalesce(p_comms, '{}'::jsonb);
  if jsonb_typeof(v_ch) <> 'object' then raise exception 'communication settings must be an object' using errcode = 'PT422'; end if;
  if v_ch ? 'preferred_channels' and exists (select 1 from jsonb_array_elements_text(v_ch -> 'preferred_channels') c where c not in ('whatsapp', 'sms', 'email')) then raise exception 'channels must be whatsapp, sms or email' using errcode = 'PT422'; end if;
  v_q := v_ch -> 'quiet_hours';
  if v_q is not null and v_q <> 'null'::jsonb and ((v_q ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (v_q ->> 'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then raise exception 'quiet hours must be HH:MM times' using errcode = 'PT422'; end if;
  v_packs := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p_rule_packs, '[]'::jsonb)) x), '{}');
  foreach v_pack in array v_packs loop
    if not exists (select 1 from public.country_rule_packs rp where rp.country || ':' || rp.code = v_pack and rp.status = 'reviewed' and rp.country = upper(p_country)) then
      raise exception 'rule pack % cannot be enabled: it does not exist for this country or has not been reviewed by a qualified person', v_pack using errcode = 'PT422';
    end if;
  end loop;
  insert into public.org_settings (org_id, country, base_currency, timezone, locale, date_format, payment_providers, comms, rule_packs, updated_by)
  values (p_org, upper(p_country), upper(p_currency), p_timezone, p_locale, p_date_format, v_prov, v_ch, v_packs, auth.uid())
  on conflict (org_id) do update set country = excluded.country, base_currency = excluded.base_currency, timezone = excluded.timezone, locale = excluded.locale, date_format = excluded.date_format,
    payment_providers = excluded.payment_providers, comms = excluded.comms, rule_packs = excluded.rule_packs, updated_by = auth.uid(), updated_at = now();
  perform app.audit(p_org, 'org.market_saved', 'organization', p_org, null, jsonb_build_object('country', upper(p_country), 'currency', upper(p_currency), 'timezone', p_timezone, 'rule_packs', v_packs), null);
  return public.get_market(p_org);
end $$;

-- What a future workflow calls to ask "is there reviewed, enabled country configuration for this?". Returns null unless both hold.
create or replace function app.rule_pack(p_org uuid, p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select rp.content from public.org_settings s join public.country_rule_packs rp on rp.country = s.country and rp.status = 'reviewed' and rp.country || ':' || rp.code = any (s.rule_packs)
   where s.org_id = p_org and rp.code = p_code order by rp.version desc limit 1 $$;

-- Operator-only: registering and reviewing packs. A review needs a named reviewer and a written note.
create or replace function public.rules_svc_register(p_country text, p_code text, p_title text, p_content jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.country_rule_packs;
begin
  insert into public.country_rule_packs (country, code, version, title, content, status)
  values (upper(p_country), p_code, coalesce((select max(version) + 1 from public.country_rule_packs where country = upper(p_country) and code = p_code), 1), p_title, coalesce(p_content, '{}'), 'draft') returning * into r;
  return jsonb_build_object('id', r.id, 'status', r.status, 'version', r.version);
end $$;

create or replace function public.rules_svc_review(p_id bigint, p_status text, p_reviewer text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('under_review', 'reviewed', 'retired') then raise exception 'invalid status' using errcode = 'PT422'; end if;
  update public.country_rule_packs set status = p_status, reviewer = p_reviewer, reviewed_at = case when p_status = 'reviewed' then now() else reviewed_at end, review_note = p_note where id = p_id;
  if not found then raise exception 'pack not found' using errcode = 'PT404'; end if;
  return jsonb_build_object('id', p_id, 'status', p_status);
end $$;

revoke all on public.currencies, public.payment_provider_registry, public.country_profiles, public.org_settings, public.country_rule_packs from anon, authenticated;
grant select on public.currencies, public.payment_provider_registry, public.country_profiles to authenticated;
grant select on public.org_settings to authenticated;
alter table public.currencies enable row level security; alter table public.payment_provider_registry enable row level security; alter table public.country_profiles enable row level security;
alter table public.org_settings enable row level security; alter table public.country_rule_packs enable row level security;
drop policy if exists currencies_read on public.currencies; create policy currencies_read on public.currencies for select to authenticated using (true);
drop policy if exists providers_read on public.payment_provider_registry; create policy providers_read on public.payment_provider_registry for select to authenticated using (true);
drop policy if exists countries_read on public.country_profiles; create policy countries_read on public.country_profiles for select to authenticated using (true);
drop policy if exists org_settings_read on public.org_settings; create policy org_settings_read on public.org_settings for select to authenticated using (app.has_role(org_id, 'viewer'));

do $$ declare r record; begin
  for r in select p.oid::regprocedure as f, p.proname as pn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('get_market', 'save_market', 'rules_svc_register', 'rules_svc_review') loop
    execute format('revoke execute on function %s from public, anon', r.f);
    if r.pn like 'rules\_svc\_%' then execute format('revoke execute on function %s from authenticated', r.f); execute format('grant execute on function %s to service_role', r.f);
    else execute format('grant execute on function %s to authenticated', r.f); end if;
  end loop;
end $$;
