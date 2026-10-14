-- Role helpers + Row Level Security for every Phase 1 table.
-- Tables are read-only to API roles; every write goes through the audited
-- SECURITY DEFINER functions in the next migration.

create or replace function app.role_rank(r public.org_role) returns int
language sql immutable set search_path = '' as $$
  select case r when 'owner' then 4 when 'admin' then 3 when 'manager' then 2
               when 'staff' then 1 else 0 end
$$;

-- SECURITY DEFINER so policies on `memberships` can consult `memberships`
-- without recursing through their own RLS.
create or replace function app.my_role(p_org uuid) returns public.org_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  where m.org_id = p_org and m.user_id = (select auth.uid())
$$;

create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.my_role(p_org) is not null
$$;

create or replace function app.has_role(p_org uuid, p_min public.org_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.role_rank(app.my_role(p_org)) >= app.role_rank(p_min), false)
$$;

create or replace function app.shares_org_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships a
    join public.memberships b on a.org_id = b.org_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user)
$$;

revoke all on schema app from public;
grant usage on schema app to authenticated;
revoke all on all functions in schema app from public, anon;
grant execute on function app.role_rank(public.org_role), app.my_role(uuid),
  app.is_member(uuid), app.has_role(uuid, public.org_role), app.shares_org_with(uuid)
  to authenticated;

-- ------------------------------------------------------------------- grants
revoke all on public.profiles, public.organizations, public.memberships, public.invitations
  from anon, authenticated;
grant select on public.profiles, public.organizations, public.memberships, public.invitations
  to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant update (name) on public.organizations to authenticated;

alter table public.profiles       enable row level security;
alter table public.organizations  enable row level security;
alter table public.memberships    enable row level security;
alter table public.invitations    enable row level security;

-- ----------------------------------------------------------------- policies
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or app.shares_org_with(id));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated
  using (app.is_member(id));

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations for update to authenticated
  using (app.has_role(id, 'admin')) with check (app.has_role(id, 'admin'));

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (app.is_member(org_id));

drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations for select to authenticated
  using (app.has_role(org_id, 'admin'));

-- No INSERT/DELETE policies exist on any table, and no INSERT/DELETE grants:
-- direct writes through the Data API are denied by default.
