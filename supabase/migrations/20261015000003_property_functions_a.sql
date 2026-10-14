-- Phase 2 RPC functions, part A: helpers, properties, owners, units.
-- Role policy: viewer reads; staff writes tenants/tenancies/leases/documents;
-- manager writes properties/units/owners, changes tenancy status, archives records.
-- Updates are full-replace and guarded by p_expected_version (optimistic concurrency, 409 on conflict).

-- ------------------------------------------------------------------ helpers
create or replace function app.valid_timezone(p text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p) $$;

create or replace function app.property_today(p_property uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone pr.timezone)::date from public.properties pr where pr.id = p_property $$;

create or replace function app.like_pattern(p text) returns text
language sql immutable set search_path = '' as $$
  select case when nullif(trim(p), '') is null then null
              else '%' || replace(replace(replace(trim(p), '\', '\\'), '%', '\%'), '_', '\_') || '%' end $$;

create or replace function app.page_limit(p int) returns int
language sql immutable set search_path = '' as $$ select least(greatest(coalesce(p, 25), 1), 100) $$;
create or replace function app.page_offset(p int) returns int
language sql immutable set search_path = '' as $$ select greatest(coalesce(p, 0), 0) $$;
create or replace function app.sort_dir(p text) returns text
language sql immutable set search_path = '' as $$ select case when lower(coalesce(p, 'asc')) = 'desc' then 'desc' else 'asc' end $$;

-- 'occupied' | 'upcoming' | 'unavailable' | 'vacant', judged on the property's local date.
create or replace function app.unit_occupancy(p_unit uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.tenancies t where t.unit_id = u.id and t.status = 'active'
                 and t.start_date <= d.today and (t.end_date is null or t.end_date >= d.today)) then 'occupied'
    when exists (select 1 from public.tenancies t where t.unit_id = u.id and t.status = 'active'
                 and t.start_date > d.today) then 'upcoming'
    when not u.is_available then 'unavailable'
    else 'vacant' end
  from public.units u cross join lateral (select app.property_today(u.property_id) as today) d
  where u.id = p_unit $$;

-- Row fetchers: 404 when the id doesn't exist *in this organization* (never reveals other orgs).
create or replace function app.load_property(p_org uuid, p_id uuid, p_lock boolean default false) returns public.properties
language plpgsql security definer set search_path = '' as $$
declare r public.properties;
begin
  if p_lock then select * into r from public.properties where id = p_id and org_id = p_org for update;
  else select * into r from public.properties where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'property not found' using errcode = 'PT404'; end if;
  return r;
end $$;
create or replace function app.load_unit(p_org uuid, p_id uuid, p_lock boolean default false) returns public.units
language plpgsql security definer set search_path = '' as $$
declare r public.units;
begin
  if p_lock then select * into r from public.units where id = p_id and org_id = p_org for update;
  else select * into r from public.units where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'unit not found' using errcode = 'PT404'; end if;
  return r;
end $$;
create or replace function app.load_owner(p_org uuid, p_id uuid, p_lock boolean default false) returns public.owners
language plpgsql security definer set search_path = '' as $$
declare r public.owners;
begin
  if p_lock then select * into r from public.owners where id = p_id and org_id = p_org for update;
  else select * into r from public.owners where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'owner not found' using errcode = 'PT404'; end if;
  return r;
end $$;
create or replace function app.load_tenant(p_org uuid, p_id uuid, p_lock boolean default false) returns public.tenants
language plpgsql security definer set search_path = '' as $$
declare r public.tenants;
begin
  if p_lock then select * into r from public.tenants where id = p_id and org_id = p_org for update;
  else select * into r from public.tenants where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'tenant not found' using errcode = 'PT404'; end if;
  return r;
end $$;
create or replace function app.load_tenancy(p_org uuid, p_id uuid, p_lock boolean default false) returns public.tenancies
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies;
begin
  if p_lock then select * into r from public.tenancies where id = p_id and org_id = p_org for update;
  else select * into r from public.tenancies where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'tenancy not found' using errcode = 'PT404'; end if;
  return r;
end $$;
create or replace function app.load_lease(p_org uuid, p_id uuid, p_lock boolean default false) returns public.leases
language plpgsql security definer set search_path = '' as $$
declare r public.leases;
begin
  if p_lock then select * into r from public.leases where id = p_id and org_id = p_org for update;
  else select * into r from public.leases where id = p_id and org_id = p_org; end if;
  if r.id is null then raise exception 'lease not found' using errcode = 'PT404'; end if;
  return r;
end $$;

create or replace function app.check_version(p_actual int, p_expected int) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is distinct from p_actual then
    raise exception 'this record was changed by someone else; reload and try again' using errcode = 'PT409';
  end if;
end $$;

create or replace function app.check_timezone(p text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not app.valid_timezone(p) then raise exception 'unknown time zone' using errcode = 'PT422'; end if;
end $$;

-- ---------------------------------------------------------------- properties
create or replace function public.create_property(
  p_org uuid, p_name text, p_reference text, p_property_type public.property_type,
  p_address_line1 text, p_address_line2 text, p_city text, p_region text, p_postal_code text,
  p_country text, p_timezone text, p_currency text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.properties;
begin
  perform app.require_role(p_org, 'manager');
  perform app.check_timezone(p_timezone);
  insert into public.properties (org_id, name, reference, property_type, address_line1, address_line2, city, region,
    postal_code, country, timezone, currency, notes, created_by)
  values (p_org, trim(p_name), nullif(trim(p_reference), ''), p_property_type, trim(p_address_line1),
    nullif(trim(p_address_line2), ''), trim(p_city), nullif(trim(p_region), ''), nullif(trim(p_postal_code), ''),
    upper(p_country), p_timezone, upper(p_currency), nullif(trim(p_notes), ''), auth.uid())
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.update_property(
  p_org uuid, p_property uuid, p_expected_version int, p_name text, p_reference text,
  p_property_type public.property_type, p_address_line1 text, p_address_line2 text, p_city text, p_region text,
  p_postal_code text, p_country text, p_timezone text, p_currency text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.properties;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_property(p_org, p_property, true);
  perform app.check_version(r.version, p_expected_version);
  perform app.check_timezone(p_timezone);
  -- Currency is copied onto tenancies; changing it once rent has been recorded would corrupt history.
  if upper(p_currency) <> r.currency and exists (
       select 1 from public.tenancies t join public.units u on u.id = t.unit_id where u.property_id = p_property) then
    raise exception 'currency cannot change once tenancies exist' using errcode = 'PT409';
  end if;
  update public.properties set name = trim(p_name), reference = nullif(trim(p_reference), ''),
    property_type = p_property_type, address_line1 = trim(p_address_line1),
    address_line2 = nullif(trim(p_address_line2), ''), city = trim(p_city), region = nullif(trim(p_region), ''),
    postal_code = nullif(trim(p_postal_code), ''), country = upper(p_country), timezone = p_timezone,
    currency = upper(p_currency), notes = nullif(trim(p_notes), ''), version = version + 1
  where id = p_property returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.get_property(p_org uuid, p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.properties;
begin
  perform app.require_role(p_org, 'viewer');
  r := app.load_property(p_org, p_property);
  return to_jsonb(r) || jsonb_build_object(
    'unit_count', (select count(*) from public.units u where u.property_id = r.id and u.archived_at is null),
    'occupied_count', (select count(*) from public.units u where u.property_id = r.id and u.archived_at is null
                       and app.unit_occupancy(u.id) = 'occupied'),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('owner_id', o.id, 'name', o.name, 'owner_type', o.owner_type,
                 'email', o.email, 'phone', o.phone, 'ownership_pct', po.ownership_pct, 'is_primary', po.is_primary,
                 'archived', o.archived_at is not null) order by po.is_primary desc, o.name)
               from public.property_owners po join public.owners o on o.id = po.owner_id where po.property_id = r.id), '[]'::jsonb));
end $$;

create or replace function public.list_properties(
  p_org uuid, p_search text default null, p_type public.property_type default null, p_archived boolean default false,
  p_sort text default 'name', p_dir text default 'asc', p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'viewer');
  v_col := case p_sort when 'name' then 'name' when 'city' then 'city' when 'type' then 'property_type'
                       when 'units' then 'unit_count' when 'created' then 'created_at' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  execute format($q$
    with filtered as (
      select p.*, (select count(*) from public.units u where u.property_id = p.id and u.archived_at is null) as unit_count,
             (select count(*) from public.units u where u.property_id = p.id and u.archived_at is null
                and app.unit_occupancy(u.id) = 'occupied') as occupied_count
      from public.properties p
      where p.org_id = $1 and (p.archived_at is not null) = $2
        and ($3::text is null or p.name ilike $3 or p.address_line1 ilike $3 or p.city ilike $3 or p.reference ilike $3)
        and ($4::public.property_type is null or p.property_type = $4))
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s, id limit $5 offset $6) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, coalesce(p_archived, false), app.like_pattern(p_search), p_type,
                   app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

create or replace function public.set_property_archived(p_org uuid, p_property uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.properties;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_property(p_org, p_property, true);
  if p_archived and exists (select 1 from public.tenancies t join public.units u on u.id = t.unit_id
                            where u.property_id = p_property and t.status in ('draft', 'active')) then
    raise exception 'end or cancel open tenancies before archiving this property' using errcode = 'PT409';
  end if;
  update public.properties set archived_at = case when p_archived then now() end, version = version + 1
   where id = p_property returning * into r;
  return to_jsonb(r);
end $$;

-- -------------------------------------------------------------------- owners
create or replace function public.create_owner(p_org uuid, p_name text, p_owner_type public.owner_type,
  p_email text, p_phone text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.owners;
begin
  perform app.require_role(p_org, 'manager');
  insert into public.owners (org_id, name, owner_type, email, phone, notes, created_by)
  values (p_org, trim(p_name), p_owner_type, nullif(lower(trim(p_email)), ''), nullif(trim(p_phone), ''),
          nullif(trim(p_notes), ''), auth.uid()) returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.update_owner(p_org uuid, p_owner uuid, p_expected_version int, p_name text,
  p_owner_type public.owner_type, p_email text, p_phone text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.owners;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_owner(p_org, p_owner, true);
  perform app.check_version(r.version, p_expected_version);
  update public.owners set name = trim(p_name), owner_type = p_owner_type, email = nullif(lower(trim(p_email)), ''),
    phone = nullif(trim(p_phone), ''), notes = nullif(trim(p_notes), ''), version = version + 1
  where id = p_owner returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.set_owner_archived(p_org uuid, p_owner uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.owners;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_owner(p_org, p_owner, true);
  update public.owners set archived_at = case when p_archived then now() end, version = version + 1
   where id = p_owner returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.list_owners(p_org uuid, p_search text default null, p_archived boolean default false,
  p_limit int default 100, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'viewer');
  return (with filtered as (
      select o.*, (select count(*) from public.property_owners po where po.owner_id = o.id) as property_count
      from public.owners o
      where o.org_id = p_org and (o.archived_at is not null) = coalesce(p_archived, false)
        and (app.like_pattern(p_search) is null or o.name ilike app.like_pattern(p_search) or o.email ilike app.like_pattern(p_search)))
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by name, id
               limit app.page_limit(p_limit) offset app.page_offset(p_offset)) f), '[]'::jsonb)));
end $$;

create or replace function public.link_property_owner(p_org uuid, p_property uuid, p_owner uuid,
  p_ownership_pct numeric, p_is_primary boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_total numeric;
begin
  perform app.require_role(p_org, 'manager');
  perform app.load_property(p_org, p_property, true);
  if (app.load_owner(p_org, p_owner)).archived_at is not null then
    raise exception 'owner is archived' using errcode = 'PT409';
  end if;
  select coalesce(sum(ownership_pct), 0) into v_total from public.property_owners
   where property_id = p_property and owner_id <> p_owner;
  if p_ownership_pct is not null and v_total + p_ownership_pct > 100 then
    raise exception 'ownership shares would exceed 100%%' using errcode = 'PT422';
  end if;
  if coalesce(p_is_primary, false) then
    update public.property_owners set is_primary = false where property_id = p_property and owner_id <> p_owner;
  end if;
  insert into public.property_owners (org_id, property_id, owner_id, ownership_pct, is_primary)
  values (p_org, p_property, p_owner, p_ownership_pct, coalesce(p_is_primary, false))
  on conflict (property_id, owner_id) do update set ownership_pct = excluded.ownership_pct, is_primary = excluded.is_primary;
  return public.get_property(p_org, p_property);
end $$;

create or replace function public.unlink_property_owner(p_org uuid, p_property uuid, p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  perform app.load_property(p_org, p_property, true);
  delete from public.property_owners where property_id = p_property and owner_id = p_owner and org_id = p_org;
  if not found then raise exception 'owner link not found' using errcode = 'PT404'; end if;
  return public.get_property(p_org, p_property);
end $$;

-- --------------------------------------------------------------------- units
create or replace function public.create_unit(p_org uuid, p_property uuid, p_reference text, p_bedrooms int,
  p_bathrooms numeric, p_floor_area_sqm numeric, p_market_rent_minor bigint, p_is_available boolean, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.units;
begin
  perform app.require_role(p_org, 'manager');
  if (app.load_property(p_org, p_property, true)).archived_at is not null then
    raise exception 'property is archived' using errcode = 'PT409';
  end if;
  begin
    insert into public.units (org_id, property_id, reference, bedrooms, bathrooms, floor_area_sqm, market_rent_minor,
      is_available, notes, created_by)
    values (p_org, p_property, trim(p_reference), p_bedrooms, p_bathrooms, p_floor_area_sqm, p_market_rent_minor,
      coalesce(p_is_available, true), nullif(trim(p_notes), ''), auth.uid()) returning * into r;
  exception when unique_violation then
    raise exception 'a unit with that reference already exists in this property' using errcode = 'PT409';
  end;
  return to_jsonb(r) || jsonb_build_object('occupancy', app.unit_occupancy(r.id));
end $$;

create or replace function public.update_unit(p_org uuid, p_unit uuid, p_expected_version int, p_reference text,
  p_bedrooms int, p_bathrooms numeric, p_floor_area_sqm numeric, p_market_rent_minor bigint, p_is_available boolean,
  p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.units;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_unit(p_org, p_unit, true);
  perform app.check_version(r.version, p_expected_version);
  begin
    update public.units set reference = trim(p_reference), bedrooms = p_bedrooms, bathrooms = p_bathrooms,
      floor_area_sqm = p_floor_area_sqm, market_rent_minor = p_market_rent_minor,
      is_available = coalesce(p_is_available, true), notes = nullif(trim(p_notes), ''), version = version + 1
    where id = p_unit returning * into r;
  exception when unique_violation then
    raise exception 'a unit with that reference already exists in this property' using errcode = 'PT409';
  end;
  return to_jsonb(r) || jsonb_build_object('occupancy', app.unit_occupancy(r.id));
end $$;

create or replace function public.get_unit(p_org uuid, p_unit uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.units; pr public.properties;
begin
  perform app.require_role(p_org, 'viewer');
  r := app.load_unit(p_org, p_unit);
  pr := app.load_property(p_org, r.property_id);
  return to_jsonb(r) || jsonb_build_object(
    'occupancy', app.unit_occupancy(r.id),
    'property', jsonb_build_object('id', pr.id, 'name', pr.name, 'timezone', pr.timezone, 'currency', pr.currency,
                                   'archived', pr.archived_at is not null),
    'tenancies', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'status', t.status, 'start_date', t.start_date,
        'end_date', t.end_date, 'rent_amount_minor', t.rent_amount_minor, 'rent_period', t.rent_period,
        'currency', t.currency,
        'primary_tenant', (select te.full_name from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id
                           where tt.tenancy_id = t.id and tt.is_primary)) order by t.start_date desc)
      from public.tenancies t where t.unit_id = r.id), '[]'::jsonb));
end $$;

create or replace function public.list_units(p_org uuid, p_property uuid default null, p_search text default null,
  p_occupancy text default null, p_archived boolean default false, p_sort text default 'reference', p_dir text default 'asc',
  p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'viewer');
  v_col := case p_sort when 'reference' then 'reference' when 'property' then 'property_name' when 'rent' then 'market_rent_minor'
                       when 'bedrooms' then 'bedrooms' when 'occupancy' then 'occupancy' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  if p_occupancy is not null and p_occupancy not in ('occupied','vacant','upcoming','unavailable') then
    raise exception 'invalid occupancy filter' using errcode = 'PT422';
  end if;
  execute format($q$
    with filtered as (
      select * from (
        select u.*, pr.name as property_name, pr.currency, pr.timezone, app.unit_occupancy(u.id) as occupancy,
          (select te.full_name from public.tenancies t join public.tenancy_tenants tt on tt.tenancy_id = t.id and tt.is_primary
             join public.tenants te on te.id = tt.tenant_id
            where t.unit_id = u.id and t.status = 'active' order by t.start_date desc limit 1) as current_tenant
        from public.units u join public.properties pr on pr.id = u.property_id
        where u.org_id = $1 and (u.archived_at is not null) = $2 and ($3::uuid is null or u.property_id = $3)
          and ($4::text is null or u.reference ilike $4 or pr.name ilike $4)) x
      where $5::text is null or x.occupancy = $5)
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, property_name, reference, id limit $6 offset $7) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, coalesce(p_archived, false), p_property, app.like_pattern(p_search), p_occupancy,
                   app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

create or replace function public.set_unit_archived(p_org uuid, p_unit uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.units;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_unit(p_org, p_unit, true);
  if p_archived and exists (select 1 from public.tenancies t where t.unit_id = p_unit and t.status in ('draft', 'active')) then
    raise exception 'end or cancel open tenancies before archiving this unit' using errcode = 'PT409';
  end if;
  if not p_archived and (app.load_property(p_org, r.property_id)).archived_at is not null then
    raise exception 'restore the property first' using errcode = 'PT409';
  end if;
  begin
    update public.units set archived_at = case when p_archived then now() end, version = version + 1
     where id = p_unit returning * into r;
  exception when unique_violation then
    raise exception 'another active unit already uses this reference' using errcode = 'PT409';
  end;
  return to_jsonb(r);
end $$;
