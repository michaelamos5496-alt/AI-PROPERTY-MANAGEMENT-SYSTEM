-- Phase 2: properties, owners, units, tenants, tenancies, leases, lease documents.
-- Deletion policy: nothing is hard-deleted by the application. Every parent -> child
-- foreign key is ON DELETE RESTRICT, so tenancy history cannot be destroyed by removing
-- a unit, property or tenant; records are archived (archived_at) instead.
-- Composite (org_id, id) foreign keys make cross-organization links impossible.

do $$ begin create type public.property_type as enum
  ('residential','apartment_building','house','commercial','mixed_use','land','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.owner_type as enum ('individual','company','trust','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.tenancy_status as enum ('draft','active','ended','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.rent_period as enum ('weekly','fortnightly','monthly','quarterly','annually');
exception when duplicate_object then null; end $$;
do $$ begin create type public.lease_kind as enum ('initial','renewal','amendment');
exception when duplicate_object then null; end $$;
do $$ begin create type public.document_type as enum ('lease','addendum','inspection','identification','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.document_status as enum ('pending','available');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- properties
create table if not exists public.properties (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  name           text not null check (char_length(name) between 1 and 120),
  reference      text check (reference is null or char_length(reference) <= 60),
  property_type  public.property_type not null default 'residential',
  address_line1  text not null check (char_length(address_line1) between 1 and 200),
  address_line2  text check (char_length(address_line2) <= 200),
  city           text not null check (char_length(city) between 1 and 100),
  region         text check (char_length(region) <= 100),
  postal_code    text check (char_length(postal_code) <= 20),
  country        char(2) not null check (country ~ '^[A-Z]{2}$'),          -- ISO 3166-1 alpha-2
  timezone       text not null check (char_length(timezone) between 1 and 64), -- IANA, validated in functions
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),         -- ISO 4217
  notes          text check (char_length(notes) <= 4000),
  version        int not null default 1,
  archived_at    timestamptz,
  created_by     uuid not null references auth.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists properties_org_idx on public.properties (org_id, archived_at);

-- ------------------------------------------------------------------- owners
-- Owners are people/companies, NOT platform users. user_id is an optional future link.
create table if not exists public.owners (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  name        text not null check (char_length(name) between 1 and 160),
  owner_type  public.owner_type not null default 'individual',
  email       text check (email is null or char_length(email) <= 254),
  phone       text check (phone is null or char_length(phone) <= 40),
  notes       text check (char_length(notes) <= 4000),
  user_id     uuid references auth.users (id) on delete set null,
  version     int not null default 1,
  archived_at timestamptz,
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists owners_org_idx on public.owners (org_id, archived_at);

-- Many-to-many: a property can have several owners, an owner several properties.
create table if not exists public.property_owners (
  org_id         uuid not null,
  property_id    uuid not null,
  owner_id       uuid not null,
  ownership_pct  numeric(5,2) check (ownership_pct is null or (ownership_pct > 0 and ownership_pct <= 100)),
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now(),
  primary key (property_id, owner_id),
  foreign key (org_id, property_id) references public.properties (org_id, id) on delete restrict,
  foreign key (org_id, owner_id)    references public.owners (org_id, id)     on delete restrict
);
create unique index if not exists property_owners_one_primary_idx
  on public.property_owners (property_id) where is_primary;
create index if not exists property_owners_owner_idx on public.property_owners (owner_id);

-- -------------------------------------------------------------------- units
create table if not exists public.units (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  property_id       uuid not null,
  reference         text not null check (char_length(reference) between 1 and 60),
  bedrooms          smallint check (bedrooms between 0 and 50),
  bathrooms         numeric(3,1) check (bathrooms between 0 and 50),
  floor_area_sqm    numeric(8,2) check (floor_area_sqm > 0),
  market_rent_minor bigint check (market_rent_minor >= 0),  -- minor currency units (cents)
  is_available      boolean not null default true,          -- false = off the market (renovation, owner use)
  notes             text check (char_length(notes) <= 4000),
  version           int not null default 1,
  archived_at       timestamptz,
  created_by        uuid not null references auth.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (org_id, property_id) references public.properties (org_id, id) on delete restrict,
  unique (org_id, id)
);
create unique index if not exists units_reference_idx
  on public.units (property_id, lower(reference)) where archived_at is null;
create index if not exists units_property_idx on public.units (property_id);

-- ------------------------------------------------------------------ tenants
create table if not exists public.tenants (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  full_name        text not null check (char_length(full_name) between 1 and 160),
  email            text check (email is null or char_length(email) <= 254),
  phone            text check (phone is null or char_length(phone) <= 40),
  emergency_name   text check (char_length(emergency_name) <= 160),
  emergency_phone  text check (char_length(emergency_phone) <= 40),
  notes            text check (char_length(notes) <= 4000),
  version          int not null default 1,
  archived_at      timestamptz,
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists tenants_org_idx on public.tenants (org_id, archived_at);

-- ---------------------------------------------------------------- tenancies
-- draft -> active -> ended ; draft -> cancelled. Ended/cancelled are terminal (history).
create table if not exists public.tenancies (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null,
  unit_id               uuid not null,
  status                public.tenancy_status not null default 'draft',
  start_date            date not null,
  end_date              date,                          -- null = open-ended / periodic
  rent_amount_minor     bigint not null check (rent_amount_minor >= 0),
  rent_period           public.rent_period not null default 'monthly',
  rent_due_day          smallint check (rent_due_day between 1 and 31),
  deposit_amount_minor  bigint not null default 0 check (deposit_amount_minor >= 0),
  deposit_scheme        text check (char_length(deposit_scheme) <= 200),
  currency              char(3) not null check (currency ~ '^[A-Z]{3}$'),  -- copied from the property
  notice_days           smallint check (notice_days between 0 and 365),
  end_reason            text check (char_length(end_reason) <= 1000),
  notes                 text check (char_length(notes) <= 4000),
  version               int not null default 1,
  activated_at          timestamptz,
  ended_at              timestamptz,
  created_by            uuid not null references auth.users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (org_id, unit_id) references public.units (org_id, id) on delete restrict,
  unique (org_id, id),
  check (end_date is null or end_date >= start_date),
  check (status <> 'ended' or end_date is not null)
);
create index if not exists tenancies_unit_idx on public.tenancies (unit_id, status);
create index if not exists tenancies_org_status_idx on public.tenancies (org_id, status);

create table if not exists public.tenancy_tenants (
  org_id      uuid not null,
  tenancy_id  uuid not null,
  tenant_id   uuid not null,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (tenancy_id, tenant_id),
  foreign key (org_id, tenancy_id) references public.tenancies (org_id, id) on delete restrict,
  foreign key (org_id, tenant_id)  references public.tenants (org_id, id)   on delete restrict
);
create unique index if not exists tenancy_tenants_one_primary_idx
  on public.tenancy_tenants (tenancy_id) where is_primary;
create index if not exists tenancy_tenants_tenant_idx on public.tenancy_tenants (tenant_id);

-- ------------------------------------------------------------------- leases
create table if not exists public.leases (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  tenancy_id   uuid not null,
  kind         public.lease_kind not null default 'initial',
  start_date   date not null,
  end_date     date,
  signed_on    date,
  notes        text check (char_length(notes) <= 4000),
  version      int not null default 1,
  archived_at  timestamptz,
  created_by   uuid not null references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (org_id, tenancy_id) references public.tenancies (org_id, id) on delete restrict,
  unique (org_id, id),
  check (end_date is null or end_date >= start_date)
);
create index if not exists leases_tenancy_idx on public.leases (tenancy_id);

-- Metadata only. File bytes live in the private `lease-documents` storage bucket.
create table if not exists public.lease_documents (
  id            uuid primary key,
  org_id        uuid not null,
  lease_id      uuid not null,
  doc_type      public.document_type not null default 'lease',
  file_name     text not null check (char_length(file_name) between 1 and 200),
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  storage_path  text not null unique,
  status        public.document_status not null default 'pending',
  uploaded_by   uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  archived_at   timestamptz,
  foreign key (org_id, lease_id) references public.leases (org_id, id) on delete restrict
);
create index if not exists lease_documents_lease_idx on public.lease_documents (lease_id);

-- ------------------------------------------------------------------ triggers
do $$
declare t text;
begin
  foreach t in array array['properties','owners','units','tenants','tenancies','leases'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function app.touch_updated_at()', t, t);
  end loop;
end $$;

-- Columns that define record identity/ownership can never change after insert.
create or replace function app.forbid_column_change() returns trigger
language plpgsql set search_path = '' as $$
declare c text;
begin
  foreach c in array tg_argv loop
    if to_jsonb(new) -> c is distinct from to_jsonb(old) -> c then
      raise exception '% cannot be changed', c using errcode = 'PT409';
    end if;
  end loop;
  return new;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('properties', array['org_id']), ('owners', array['org_id']), ('tenants', array['org_id']),
    ('units', array['org_id','property_id']), ('tenancies', array['org_id','unit_id']),
    ('leases', array['org_id','tenancy_id']),
    ('lease_documents', array['org_id','lease_id','storage_path'])) v(t, cols)
  loop
    execute format('drop trigger if exists %I_immutable on public.%I', r.t, r.t);
    execute format('create trigger %I_immutable before update on public.%I for each row execute function app.forbid_column_change(%s)',
      r.t, r.t, (select string_agg(quote_literal(c), ',') from unnest(r.cols) c));
  end loop;
end $$;

-- Defence in depth: legal status transitions are enforced by the database, not just the API.
create or replace function app.enforce_tenancy_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'draft'  and new.status in ('active', 'cancelled')) or
       (old.status = 'active' and new.status = 'ended')) then
    raise exception 'illegal tenancy status change % -> %', old.status, new.status using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists tenancies_transition on public.tenancies;
create trigger tenancies_transition before update on public.tenancies
  for each row execute function app.enforce_tenancy_transition();
