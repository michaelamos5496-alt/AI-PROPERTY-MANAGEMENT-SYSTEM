-- Phase 4 functions, part A: notification helpers, settings, urgency levels, vendors, tenant portal access.

-- ------------------------------------------------------------ notification helpers
-- In-app notification and/or queued email for one user, honouring their preferences. Mandatory event types
-- (e.g. critical escalations) ignore opt-outs. Dedupe keys make every call safe to repeat.
create or replace function app.notify_user(p_org uuid, p_user uuid, p_event text, p_title text, p_body text, p_link text, p_dedupe text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare ev public.notification_event_types; pf public.notification_prefs; v_email boolean; v_app boolean; v_addr text; v_name text; v_rows int; v_new boolean := false;
begin
  select * into ev from public.notification_event_types where event_type = p_event;
  if ev.event_type is null then raise exception 'unknown event type %', p_event; end if;
  select * into pf from public.notification_prefs where org_id = p_org and user_id = p_user and event_type = p_event;
  v_email := ev.mandatory or coalesce(pf.email, ev.default_email);
  v_app := ev.mandatory or coalesce(pf.in_app, ev.default_in_app);
  select email, nullif(full_name, '') into v_addr, v_name from public.profiles where id = p_user;
  if v_addr is null then return false; end if;
  if v_app then
    insert into public.notifications (org_id, user_id, event_type, title, body, link, dedupe_key)
    values (p_org, p_user, p_event, left(p_title, 200), left(p_body, 2000), p_link, p_dedupe) on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count; v_new := v_rows > 0;
  end if;
  if v_email and v_addr <> '' then
    insert into public.email_queue (org_id, recipient_email, recipient_user_id, recipient_name, event_type, subject, body_text, link, dedupe_key)
    values (p_org, v_addr, p_user, v_name, p_event, left(p_title, 200), left(coalesce(p_body, p_title), 8000), p_link, 'u:' || p_user || ':' || p_dedupe)
    on conflict (org_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count; v_new := v_new or v_rows > 0;
  end if;
  return v_new;
end $$;

-- Email to an address that may not be a user (e.g. a tenant without an account, or a vendor).
create or replace function app.notify_email(p_org uuid, p_email text, p_name text, p_event text, p_subject text, p_body text, p_link text, p_dedupe text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_rows int;
begin
  if p_email is null or btrim(p_email) = '' then return false; end if;
  insert into public.email_queue (org_id, recipient_email, recipient_name, event_type, subject, body_text, link, dedupe_key)
  values (p_org, lower(btrim(p_email)), p_name, p_event, left(p_subject, 200), left(coalesce(p_body, p_subject), 8000), p_link, 'e:' || lower(btrim(p_email)) || ':' || p_dedupe)
  on conflict (org_id, dedupe_key) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

create or replace function app.notify_role(p_org uuid, p_min public.org_role, p_event text, p_title text, p_body text, p_link text, p_dedupe text, p_except uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare m record; v_n int := 0;
begin
  for m in select user_id from public.memberships where org_id = p_org and app.role_rank(role) >= app.role_rank(p_min) and user_id is distinct from p_except order by user_id loop
    if app.notify_user(p_org, m.user_id, p_event, p_title, p_body, p_link, p_dedupe) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

create or replace function app.role_of_user(p_org uuid, p_user uuid) returns public.org_role
language sql stable security definer set search_path = '' as $$ select role from public.memberships where org_id = p_org and user_id = p_user $$;

-- -------------------------------------------------------------- defaults + settings
create or replace function app.ensure_maintenance_defaults(p_org uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.urgency_levels (org_id, key, label, rank, is_critical, tenant_selectable, is_default) values
    (p_org, 'low', 'Low', 10, false, true, false), (p_org, 'routine', 'Routine', 20, false, true, true),
    (p_org, 'urgent', 'Urgent', 30, false, true, false), (p_org, 'emergency', 'Emergency', 40, true, true, false)
  on conflict (org_id, key) do nothing;
  insert into public.maintenance_settings (org_id) values (p_org) on conflict (org_id) do nothing;
$$;

create or replace function app.settings(p_org uuid) returns public.maintenance_settings
language plpgsql security definer set search_path = '' as $$
declare s public.maintenance_settings;
begin
  perform app.ensure_maintenance_defaults(p_org);
  select * into s from public.maintenance_settings where org_id = p_org;
  return s;
end $$;

create or replace function public.get_maintenance_settings(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.maintenance_settings;
begin
  perform app.require_role(p_org, 'staff');
  s := app.settings(p_org);
  return jsonb_build_object('escalation_user_id', s.escalation_user_id, 'backup_user_id', s.backup_user_id,
    'escalation_user', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = s.escalation_user_id),
    'backup_user', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = s.backup_user_id),
    'critical_keywords', to_jsonb(s.critical_keywords), 'ack_hours', s.ack_hours, 'approval_thresholds', s.approval_thresholds,
    'allow_self_approval', s.allow_self_approval, 'updated_at', s.updated_at);
end $$;

create or replace function public.update_maintenance_settings(p_org uuid, p_escalation_user uuid, p_backup_user uuid, p_critical_keywords jsonb,
  p_ack_hours int, p_approval_thresholds jsonb, p_allow_self_approval boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; v_kw text[]; r record;
begin
  perform app.require_role(p_org, 'admin');
  perform app.settings(p_org);
  if p_escalation_user is not null and app.role_rank(app.role_of_user(p_org, p_escalation_user)) < app.role_rank('manager') then
    raise exception 'the escalation contact must be a manager, admin or owner of this organization' using errcode = 'PT422';
  end if;
  if p_backup_user is not null and app.role_rank(app.role_of_user(p_org, p_backup_user)) < app.role_rank('manager') then
    raise exception 'the backup contact must be a manager, admin or owner of this organization' using errcode = 'PT422';
  end if;
  if jsonb_typeof(p_critical_keywords) is distinct from 'array' or jsonb_array_length(p_critical_keywords) > 100 then
    raise exception 'critical keywords must be a list of at most 100 phrases' using errcode = 'PT422';
  end if;
  v_kw := array(select lower(btrim(x)) from jsonb_array_elements_text(p_critical_keywords) x);
  foreach k in array v_kw loop
    if char_length(k) not between 2 and 60 then raise exception 'each keyword must be 2-60 characters' using errcode = 'PT422'; end if;
  end loop;
  if jsonb_typeof(p_approval_thresholds) is distinct from 'object' then raise exception 'thresholds must be an object of currency to amount' using errcode = 'PT422'; end if;
  for r in select key, value from jsonb_each(p_approval_thresholds) loop
    if r.key !~ '^[A-Z]{3}$' or jsonb_typeof(r.value) <> 'number' or (r.value #>> '{}')::numeric <> trunc((r.value #>> '{}')::numeric)
       or (r.value #>> '{}')::numeric < 1 or (r.value #>> '{}')::numeric > 1000000000000 then
      raise exception 'invalid threshold for %', r.key using errcode = 'PT422';
    end if;
  end loop;
  update public.maintenance_settings set escalation_user_id = p_escalation_user, backup_user_id = p_backup_user, critical_keywords = v_kw,
    ack_hours = p_ack_hours, approval_thresholds = p_approval_thresholds, allow_self_approval = coalesce(p_allow_self_approval, false),
    updated_by = auth.uid(), updated_at = now() where org_id = p_org;
  return public.get_maintenance_settings(p_org);
end $$;

-- -------------------------------------------------------------- urgency levels
create or replace function public.list_urgency_levels(p_org uuid, p_include_archived boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  perform app.ensure_maintenance_defaults(p_org);
  return coalesce((select jsonb_agg(to_jsonb(u) - 'org_id' order by u.rank, u.key) from public.urgency_levels u
                    where u.org_id = p_org and (coalesce(p_include_archived, false) or u.archived_at is null)), '[]'::jsonb);
end $$;

create or replace function app.check_urgency_invariants(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.urgency_levels where org_id = p_org and archived_at is null and is_critical) then
    raise exception 'at least one active urgency level must be critical so emergencies are always escalated' using errcode = 'PT409';
  end if;
  if (select count(*) from public.urgency_levels where org_id = p_org and archived_at is null and is_default) <> 1 then
    raise exception 'exactly one active urgency level must be the default' using errcode = 'PT409';
  end if;
end $$;

create or replace function public.save_urgency_level(p_org uuid, p_id uuid, p_key text, p_label text, p_rank int, p_is_critical boolean,
  p_tenant_selectable boolean, p_is_default boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.urgency_levels;
begin
  perform app.require_role(p_org, 'manager');
  perform app.ensure_maintenance_defaults(p_org);
  if p_id is null then
    begin
      insert into public.urgency_levels (org_id, key, label, rank, is_critical, tenant_selectable, is_default)
      values (p_org, lower(btrim(p_key)), btrim(p_label), p_rank, coalesce(p_is_critical, false), coalesce(p_tenant_selectable, true), false) returning * into r;
    exception when unique_violation then raise exception 'an urgency level with that key already exists' using errcode = 'PT409'; end;
  else
    select * into r from public.urgency_levels where id = p_id and org_id = p_org for update;
    if r.id is null then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
    update public.urgency_levels set label = btrim(p_label), rank = p_rank, is_critical = coalesce(p_is_critical, false),
      tenant_selectable = coalesce(p_tenant_selectable, true) where id = p_id returning * into r;
  end if;
  if coalesce(p_is_default, false) and not r.is_default then
    update public.urgency_levels set is_default = false where org_id = p_org and is_default and id <> r.id;
    update public.urgency_levels set is_default = true where id = r.id returning * into r;
  end if;
  perform app.check_urgency_invariants(p_org);
  return to_jsonb(r) - 'org_id';
end $$;

create or replace function public.set_urgency_archived(p_org uuid, p_id uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.urgency_levels;
begin
  perform app.require_role(p_org, 'manager');
  select * into r from public.urgency_levels where id = p_id and org_id = p_org for update;
  if r.id is null then raise exception 'urgency level not found' using errcode = 'PT404'; end if;
  if p_archived and r.is_default then raise exception 'choose another default level before archiving this one' using errcode = 'PT409'; end if;
  update public.urgency_levels set archived_at = case when p_archived then now() end where id = p_id returning * into r;
  perform app.check_urgency_invariants(p_org);
  return to_jsonb(r) - 'org_id';
end $$;

-- ------------------------------------------------------------------- vendors
create or replace function public.save_vendor(p_org uuid, p_vendor uuid, p_expected_version int, p_name text, p_contact_name text, p_email text,
  p_phone text, p_categories jsonb, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.vendors; v_cats public.maintenance_category[];
begin
  perform app.require_role(p_org, 'manager');
  v_cats := array(select x::public.maintenance_category from jsonb_array_elements_text(coalesce(p_categories, '[]'::jsonb)) x);
  if p_vendor is null then
    insert into public.vendors (org_id, name, contact_name, email, phone, categories, notes, created_by)
    values (p_org, btrim(p_name), nullif(btrim(p_contact_name), ''), nullif(lower(btrim(p_email)), ''), nullif(btrim(p_phone), ''), v_cats, nullif(btrim(p_notes), ''), auth.uid())
    returning * into r;
  else
    select * into r from public.vendors where id = p_vendor and org_id = p_org for update;
    if r.id is null then raise exception 'vendor not found' using errcode = 'PT404'; end if;
    perform app.check_version(r.version, p_expected_version);
    update public.vendors set name = btrim(p_name), contact_name = nullif(btrim(p_contact_name), ''), email = nullif(lower(btrim(p_email)), ''),
      phone = nullif(btrim(p_phone), ''), categories = v_cats, notes = nullif(btrim(p_notes), ''), version = version + 1 where id = p_vendor returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.set_vendor_archived(p_org uuid, p_vendor uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.vendors;
begin
  perform app.require_role(p_org, 'manager');
  update public.vendors set archived_at = case when p_archived then now() end, version = version + 1 where id = p_vendor and org_id = p_org returning * into r;
  if r.id is null then raise exception 'vendor not found' using errcode = 'PT404'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.list_vendors(p_org uuid, p_search text default null, p_category public.maintenance_category default null, p_archived boolean default false,
  p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  return (with filtered as (select v.* from public.vendors v where v.org_id = p_org and (v.archived_at is not null) = coalesce(p_archived, false)
        and (p_category is null or p_category = any (v.categories))
        and (app.like_pattern(p_search) is null or v.name ilike app.like_pattern(p_search) or v.contact_name ilike app.like_pattern(p_search) or v.email ilike app.like_pattern(p_search)))
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by name, id limit app.page_limit(p_limit) offset app.page_offset(p_offset)) f), '[]'::jsonb)));
end $$;

-- ------------------------------------------------------------- tenant portal access
create or replace function public.invite_tenant_to_portal(p_org uuid, p_tenant uuid, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenants; r public.tenant_invitations;
begin
  perform app.require_role(p_org, 'manager');
  t := app.load_tenant(p_org, p_tenant, true);
  if t.archived_at is not null then raise exception 'tenant is archived' using errcode = 'PT409'; end if;
  if t.email is null then raise exception 'add an email address to this tenant first: the invitation is verified against it' using errcode = 'PT422'; end if;
  update public.tenant_invitations set revoked_at = now() where tenant_id = p_tenant and accepted_at is null and revoked_at is null;
  insert into public.tenant_invitations (org_id, tenant_id, email, token_hash, invited_by) values (p_org, p_tenant, lower(t.email), p_token_hash, auth.uid()) returning * into r;
  return jsonb_build_object('id', r.id, 'email', r.email, 'expires_at', r.expires_at);
end $$;

create or replace function public.accept_tenant_invitation(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := app.require_user(); v_email text; v_inv public.tenant_invitations;
begin
  select lower(email) into v_email from auth.users where id = uid and email_confirmed_at is not null;
  select * into v_inv from public.tenant_invitations where token_hash = p_token_hash and accepted_at is null and revoked_at is null and expires_at > now() for update;
  if v_inv.id is null or v_email is null or v_inv.email <> v_email then raise exception 'invitation is invalid or expired' using errcode = 'PT404'; end if;
  insert into public.tenant_users (org_id, tenant_id, user_id, verified_by) values (v_inv.org_id, v_inv.tenant_id, uid, v_inv.invited_by) on conflict do nothing;
  update public.tenant_invitations set accepted_at = now(), accepted_by = uid where id = v_inv.id;
  return jsonb_build_object('org_id', v_inv.org_id, 'tenant_id', v_inv.tenant_id);
end $$;

create or replace function public.get_tenant_portal_access(p_org uuid, p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  perform app.load_tenant(p_org, p_tenant);
  return jsonb_build_object(
    'users', coalesce((select jsonb_agg(jsonb_build_object('id', tu.id, 'email', p.email, 'name', nullif(p.full_name, ''), 'verified_at', tu.verified_at) order by tu.verified_at)
                         from public.tenant_users tu join public.profiles p on p.id = tu.user_id where tu.tenant_id = p_tenant and tu.revoked_at is null), '[]'::jsonb),
    'pending_invitation', (select jsonb_build_object('id', i.id, 'email', i.email, 'expires_at', i.expires_at) from public.tenant_invitations i
                            where i.tenant_id = p_tenant and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()));
end $$;

create or replace function public.revoke_tenant_portal_access(p_org uuid, p_link uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  update public.tenant_users set revoked_at = now(), revoked_by = auth.uid() where id = p_link and org_id = p_org and revoked_at is null;
  if not found then raise exception 'portal access not found' using errcode = 'PT404'; end if;
  return jsonb_build_object('revoked', p_link);
end $$;

create or replace function public.set_tenant_reminders(p_org uuid, p_tenant uuid, p_opt_out boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  perform app.load_tenant(p_org, p_tenant);
  update public.tenants set reminders_opt_out = coalesce(p_opt_out, false) where id = p_tenant;
  return jsonb_build_object('tenant_id', p_tenant, 'reminders_opt_out', coalesce(p_opt_out, false));
end $$;

-- The tenants (and orgs) a signed-in user is verified for, with the active tenancies they may raise requests against.
create or replace function app.tenant_ids_for(p_org uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(tenant_id), '{}') from public.tenant_users where org_id = p_org and user_id = (select auth.uid()) and revoked_at is null $$;

create or replace function public.portal_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := app.require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'org_id', o.id, 'org_name', o.name,
      'tenant_id', te.id, 'tenant_name', te.full_name,
      'tenancies', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'status', t.status, 'unit_reference', u.reference, 'property_name', pr.name, 'start_date', t.start_date, 'end_date', t.end_date)
                               order by t.start_date desc)
                             from public.tenancy_tenants tt join public.tenancies t on t.id = tt.tenancy_id join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id
                            where tt.tenant_id = te.id and t.status = 'active'), '[]'::jsonb)))
    from public.tenant_users tu join public.tenants te on te.id = tu.tenant_id join public.organizations o on o.id = tu.org_id
    where tu.user_id = uid and tu.revoked_at is null), '[]'::jsonb);
end $$;

create or replace function public.portal_urgency_levels(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if cardinality(app.tenant_ids_for(p_org)) = 0 then raise exception 'not found' using errcode = 'PT404'; end if;
  perform app.ensure_maintenance_defaults(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'is_default', is_default) order by rank) from public.urgency_levels
                    where org_id = p_org and archived_at is null and tenant_selectable), '[]'::jsonb);
end $$;

-- get_me now also reports tenant-portal links, so the app can route portal-only users to the portal.
create or replace function public.get_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := app.require_user();
begin
  return jsonb_build_object(
    'profile', (select to_jsonb(p) - 'created_at' - 'updated_at' from public.profiles p where p.id = uid),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'slug', o.slug, 'role', m.role) order by o.name)
      from public.memberships m join public.organizations o on o.id = m.org_id where m.user_id = uid), '[]'::jsonb),
    'tenant_links', coalesce((
      select jsonb_agg(jsonb_build_object('org_id', o.id, 'org_name', o.name, 'tenant_id', tu.tenant_id) order by o.name)
      from public.tenant_users tu join public.organizations o on o.id = tu.org_id where tu.user_id = uid and tu.revoked_at is null), '[]'::jsonb));
end $$;
