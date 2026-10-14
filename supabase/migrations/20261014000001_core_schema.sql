-- Phase 1: profiles, organizations, memberships, invitations.
-- Repeatable: every statement is guarded so re-running is a no-op.

create schema if not exists app;
comment on schema app is 'Internal helpers. Not exposed through the Data API.';

do $$ begin
  create type public.org_role as enum ('owner', 'admin', 'manager', 'staff', 'viewer');
exception when duplicate_object then null; end $$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '' check (char_length(full_name) <= 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''),
          left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ----------------------------------------------------------- organizations
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists organizations_touch on public.organizations;
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

-- -------------------------------------------------------------- memberships
create table if not exists public.memberships (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.org_role not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);
drop trigger if exists memberships_touch on public.memberships;
create trigger memberships_touch before update on public.memberships
  for each row execute function app.touch_updated_at();

-- -------------------------------------------------------------- invitations
create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  email        text not null check (email = lower(email) and char_length(email) <= 254),
  role         public.org_role not null check (role <> 'owner'),
  token_hash   text not null unique,        -- sha256 of the emailed token; the token itself is never stored
  invited_by   uuid not null references auth.users (id),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists invitations_org_idx on public.invitations (org_id);
create unique index if not exists invitations_one_pending_idx
  on public.invitations (org_id, email) where accepted_at is null and revoked_at is null;
