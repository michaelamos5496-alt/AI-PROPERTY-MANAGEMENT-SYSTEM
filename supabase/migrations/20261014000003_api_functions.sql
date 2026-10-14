-- RPC surface used by the server. All are SECURITY DEFINER with explicit
-- authorization checks (PostgREST maps SQLSTATE PTxxx to HTTP status xxx).

create or replace function app.require_user() returns uuid
language plpgsql stable set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'authentication required' using errcode = 'PT401'; end if;
  return uid;
end $$;

create or replace function app.require_role(p_org uuid, p_min public.org_role) returns public.org_role
language plpgsql stable security definer set search_path = '' as $$
declare r public.org_role := app.my_role(p_org);
begin
  -- Non-members get 404 so organization ids cannot be probed.
  if r is null then raise exception 'organization not found' using errcode = 'PT404'; end if;
  if app.role_rank(r) < app.role_rank(p_min) then
    raise exception 'insufficient role' using errcode = 'PT403';
  end if;
  return r;
end $$;

create or replace function app.slugify(p text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(trim(both '-' from left(
    regexp_replace(lower(p), '[^a-z0-9]+', '-', 'g'), 40)), ''), 'org')
$$;

create or replace function public.get_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := app.require_user();
begin
  return jsonb_build_object(
    'profile', (select to_jsonb(p) - 'created_at' - 'updated_at' from public.profiles p where p.id = uid),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'slug', o.slug, 'role', m.role)
                       order by o.name)
      from public.memberships m join public.organizations o on o.id = m.org_id
      where m.user_id = uid), '[]'::jsonb));
end $$;

create or replace function public.update_profile(p_full_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := app.require_user();
begin
  update public.profiles set full_name = left(trim(p_full_name), 120) where id = uid;
  return public.get_me() -> 'profile';
end $$;

create or replace function public.create_organization(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := app.require_user();
  v_org public.organizations;
  v_name text := trim(p_name);
begin
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'name must be 2-120 characters' using errcode = 'PT422';
  end if;
  insert into public.organizations (name, slug, created_by)
  values (v_name, app.slugify(v_name) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6), uid)
  returning * into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org.id, uid, 'owner');
  return jsonb_build_object('id', v_org.id, 'name', v_org.name, 'slug', v_org.slug, 'role', 'owner');
end $$;

create or replace function public.get_organization(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.org_role;
begin
  perform app.require_user();
  r := app.require_role(p_org, 'viewer');
  return (select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug,
                                    'role', r, 'created_at', o.created_at)
          from public.organizations o where o.id = p_org);
end $$;

create or replace function public.update_organization(p_org uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_user();
  perform app.require_role(p_org, 'admin');
  if char_length(trim(p_name)) < 2 or char_length(trim(p_name)) > 120 then
    raise exception 'name must be 2-120 characters' using errcode = 'PT422';
  end if;
  update public.organizations set name = trim(p_name) where id = p_org;
  return public.get_organization(p_org);
end $$;

create or replace function public.list_members(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_user();
  perform app.require_role(p_org, 'viewer');
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
             'full_name', p.full_name, 'email', p.email, 'joined_at', m.created_at)
           order by app.role_rank(m.role) desc, p.email)
    from public.memberships m join public.profiles p on p.id = m.user_id
    where m.org_id = p_org), '[]'::jsonb);
end $$;

create or replace function public.change_member_role(p_org uuid, p_user uuid, p_role public.org_role)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.org_role;
  target public.org_role;
begin
  perform app.require_user();
  actor := app.require_role(p_org, 'admin');
  select role into target from public.memberships where org_id = p_org and user_id = p_user;
  if target is null then raise exception 'member not found' using errcode = 'PT404'; end if;
  -- Only owners may grant, revoke, or alter the owner role.
  if (p_role = 'owner' or target = 'owner') and actor <> 'owner' then
    raise exception 'only owners can change owner roles' using errcode = 'PT403';
  end if;
  if target = 'owner' and p_role <> 'owner'
     and (select count(*) from public.memberships where org_id = p_org and role = 'owner') <= 1 then
    raise exception 'an organization must keep at least one owner' using errcode = 'PT409';
  end if;
  update public.memberships set role = p_role where org_id = p_org and user_id = p_user;
  return jsonb_build_object('user_id', p_user, 'role', p_role);
end $$;

create or replace function public.remove_member(p_org uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := app.require_user();
  actor public.org_role := app.require_role(p_org, 'viewer');
  target public.org_role;
begin
  select role into target from public.memberships where org_id = p_org and user_id = p_user;
  if target is null then raise exception 'member not found' using errcode = 'PT404'; end if;
  if p_user <> uid then          -- leaving voluntarily is always allowed
    if app.role_rank(actor) < app.role_rank('admin') then
      raise exception 'insufficient role' using errcode = 'PT403';
    end if;
    if target = 'owner' and actor <> 'owner' then
      raise exception 'only owners can remove owners' using errcode = 'PT403';
    end if;
  end if;
  if target = 'owner'
     and (select count(*) from public.memberships where org_id = p_org and role = 'owner') <= 1 then
    raise exception 'an organization must keep at least one owner' using errcode = 'PT409';
  end if;
  delete from public.memberships where org_id = p_org and user_id = p_user;
  return jsonb_build_object('removed', p_user);
end $$;

create or replace function public.create_invitation(
  p_org uuid, p_email text, p_role public.org_role, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := app.require_user();
  v_email text := lower(trim(p_email));
  v_inv public.invitations;
begin
  perform app.require_role(p_org, 'admin');
  if p_role = 'owner' then
    raise exception 'owners cannot be invited; promote an existing member' using errcode = 'PT422';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.memberships m join public.profiles p on p.id = m.user_id
             where m.org_id = p_org and lower(p.email) = v_email) then
    raise exception 'already a member' using errcode = 'PT409';
  end if;
  -- Re-inviting replaces any still-pending invitation for that address.
  update public.invitations set revoked_at = now()
   where org_id = p_org and email = v_email and accepted_at is null and revoked_at is null;
  insert into public.invitations (org_id, email, role, token_hash, invited_by)
  values (p_org, v_email, p_role, p_token_hash, uid) returning * into v_inv;
  return jsonb_build_object('id', v_inv.id, 'email', v_inv.email, 'role', v_inv.role,
                            'expires_at', v_inv.expires_at);
end $$;

create or replace function public.list_invitations(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_user();
  perform app.require_role(p_org, 'admin');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role,
             'expires_at', i.expires_at, 'created_at', i.created_at) order by i.created_at desc)
    from public.invitations i
    where i.org_id = p_org and i.accepted_at is null and i.revoked_at is null
      and i.expires_at > now()), '[]'::jsonb);
end $$;

create or replace function public.revoke_invitation(p_org uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_user();
  perform app.require_role(p_org, 'admin');
  update public.invitations set revoked_at = now()
   where id = p_id and org_id = p_org and accepted_at is null and revoked_at is null;
  if not found then raise exception 'invitation not found' using errcode = 'PT404'; end if;
  return jsonb_build_object('revoked', p_id);
end $$;

create or replace function public.accept_invitation(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := app.require_user();
  v_email text;
  v_inv public.invitations;
begin
  -- The invitation is only honoured for a verified address matching the invite.
  select lower(email) into v_email from auth.users
   where id = uid and email_confirmed_at is not null;
  select * into v_inv from public.invitations
   where token_hash = p_token_hash and accepted_at is null and revoked_at is null
     and expires_at > now() for update;
  if v_inv.id is null or v_email is null or v_inv.email <> v_email then
    raise exception 'invitation is invalid or expired' using errcode = 'PT404';
  end if;
  insert into public.memberships (org_id, user_id, role) values (v_inv.org_id, uid, v_inv.role)
  on conflict (org_id, user_id) do nothing;
  update public.invitations set accepted_at = now(), accepted_by = uid where id = v_inv.id;
  return (select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'role', app.my_role(o.id))
          from public.organizations o where o.id = v_inv.org_id);
end $$;

-- Only signed-in users may call the RPC surface.
revoke all on all functions in schema public from public, anon;
grant execute on function
  public.get_me(), public.update_profile(text), public.create_organization(text),
  public.get_organization(uuid), public.update_organization(uuid, text),
  public.list_members(uuid), public.change_member_role(uuid, uuid, public.org_role),
  public.remove_member(uuid, uuid),
  public.create_invitation(uuid, text, public.org_role, text),
  public.list_invitations(uuid), public.revoke_invitation(uuid, uuid),
  public.accept_invitation(text)
  to authenticated;
revoke all on all functions in schema app from public, anon;
grant execute on function app.require_user(), app.require_role(uuid, public.org_role),
  app.slugify(text) to authenticated;

-- Future functions in these schemas are private unless explicitly granted.
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema app revoke execute on functions from public, anon;
