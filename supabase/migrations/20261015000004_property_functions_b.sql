-- Phase 2 RPC functions, part B: tenants, tenancies, leases, documents.

-- ------------------------------------------------------------------ tenants
create or replace function public.create_tenant(p_org uuid, p_full_name text, p_email text, p_phone text,
  p_emergency_name text, p_emergency_phone text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenants;
begin
  perform app.require_role(p_org, 'staff');
  insert into public.tenants (org_id, full_name, email, phone, emergency_name, emergency_phone, notes, created_by)
  values (p_org, trim(p_full_name), nullif(lower(trim(p_email)), ''), nullif(trim(p_phone), ''),
          nullif(trim(p_emergency_name), ''), nullif(trim(p_emergency_phone), ''), nullif(trim(p_notes), ''), auth.uid())
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.update_tenant(p_org uuid, p_tenant uuid, p_expected_version int, p_full_name text,
  p_email text, p_phone text, p_emergency_name text, p_emergency_phone text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenants;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_tenant(p_org, p_tenant, true);
  perform app.check_version(r.version, p_expected_version);
  update public.tenants set full_name = trim(p_full_name), email = nullif(lower(trim(p_email)), ''),
    phone = nullif(trim(p_phone), ''), emergency_name = nullif(trim(p_emergency_name), ''),
    emergency_phone = nullif(trim(p_emergency_phone), ''), notes = nullif(trim(p_notes), ''), version = version + 1
  where id = p_tenant returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.get_tenant(p_org uuid, p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.tenants;
begin
  perform app.require_role(p_org, 'viewer');
  r := app.load_tenant(p_org, p_tenant);
  return to_jsonb(r) || jsonb_build_object('tenancies', coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'status', t.status, 'start_date', t.start_date, 'end_date', t.end_date,
        'rent_amount_minor', t.rent_amount_minor, 'rent_period', t.rent_period, 'currency', t.currency,
        'is_primary', tt.is_primary, 'unit_id', u.id, 'unit_reference', u.reference, 'property_id', pr.id,
        'property_name', pr.name) order by t.start_date desc)
    from public.tenancy_tenants tt join public.tenancies t on t.id = tt.tenancy_id
      join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id
    where tt.tenant_id = r.id), '[]'::jsonb));
end $$;

create or replace function public.list_tenants(p_org uuid, p_search text default null, p_status text default null,
  p_archived boolean default false, p_sort text default 'name', p_dir text default 'asc',
  p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'viewer');
  v_col := case p_sort when 'name' then 'full_name' when 'email' then 'email' when 'created' then 'created_at'
                       when 'tenancies' then 'active_tenancies' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  if p_status is not null and p_status not in ('current', 'former') then
    raise exception 'invalid status filter' using errcode = 'PT422';
  end if;
  execute format($q$
    with filtered as (
      select * from (
        select te.*, (select count(*) from public.tenancy_tenants tt join public.tenancies t on t.id = tt.tenancy_id
                      where tt.tenant_id = te.id and t.status = 'active') as active_tenancies
        from public.tenants te
        where te.org_id = $1 and (te.archived_at is not null) = $2
          and ($3::text is null or te.full_name ilike $3 or te.email ilike $3 or te.phone ilike $3)) x
      where $4::text is null or ($4 = 'current' and x.active_tenancies > 0) or ($4 = 'former' and x.active_tenancies = 0))
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $5 offset $6) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, coalesce(p_archived, false), app.like_pattern(p_search), p_status,
                   app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

create or replace function public.set_tenant_archived(p_org uuid, p_tenant uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenants;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_tenant(p_org, p_tenant, true);
  if p_archived and exists (select 1 from public.tenancy_tenants tt join public.tenancies t on t.id = tt.tenancy_id
                            where tt.tenant_id = p_tenant and t.status in ('draft', 'active')) then
    raise exception 'this tenant is on an open tenancy; end or cancel it first' using errcode = 'PT409';
  end if;
  update public.tenants set archived_at = case when p_archived then now() end, version = version + 1
   where id = p_tenant returning * into r;
  return to_jsonb(r);
end $$;

-- ---------------------------------------------------------------- tenancies
create or replace function app.assert_no_overlap(p_unit uuid, p_self uuid, p_start date, p_end date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.tenancies t
             where t.unit_id = p_unit and t.status = 'active' and t.id is distinct from p_self
               and t.start_date <= coalesce(p_end, 'infinity'::date)
               and coalesce(t.end_date, 'infinity'::date) >= p_start) then
    raise exception 'another active tenancy overlaps these dates for this unit' using errcode = 'PT409';
  end if;
end $$;

create or replace function app.tenancy_summary(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(t) || jsonb_build_object(
    'unit_reference', u.reference, 'property_id', pr.id, 'property_name', pr.name, 'timezone', pr.timezone,
    'primary_tenant', (select te.full_name from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id
                       where tt.tenancy_id = t.id and tt.is_primary))
  from public.tenancies t join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id
  where t.id = p_id $$;

create or replace function public.create_tenancy(p_org uuid, p_unit uuid, p_start_date date, p_end_date date,
  p_rent_amount_minor bigint, p_rent_period public.rent_period, p_rent_due_day int, p_deposit_amount_minor bigint,
  p_deposit_scheme text, p_notice_days int, p_notes text, p_tenant_ids jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.units; pr public.properties; r public.tenancies; v_id uuid; v_first boolean := true;
begin
  perform app.require_role(p_org, 'staff');
  u := app.load_unit(p_org, p_unit);
  pr := app.load_property(p_org, u.property_id);
  if u.archived_at is not null or pr.archived_at is not null then
    raise exception 'unit or property is archived' using errcode = 'PT409';
  end if;
  if jsonb_typeof(p_tenant_ids) is distinct from 'array' or jsonb_array_length(p_tenant_ids) < 1 then
    raise exception 'a tenancy needs at least one tenant' using errcode = 'PT422';
  end if;
  insert into public.tenancies (org_id, unit_id, start_date, end_date, rent_amount_minor, rent_period, rent_due_day,
      deposit_amount_minor, deposit_scheme, currency, notice_days, notes, created_by)
  values (p_org, p_unit, p_start_date, p_end_date, p_rent_amount_minor, coalesce(p_rent_period, 'monthly'), p_rent_due_day,
      coalesce(p_deposit_amount_minor, 0), nullif(trim(p_deposit_scheme), ''), pr.currency, p_notice_days,
      nullif(trim(p_notes), ''), auth.uid())
  returning * into r;
  -- The first tenant listed is the primary; duplicates are ignored but order is preserved.
  for v_id in select x::uuid from jsonb_array_elements_text(p_tenant_ids) with ordinality as t(x, n) order by n loop
    if (app.load_tenant(p_org, v_id)).archived_at is not null then
      raise exception 'tenant is archived' using errcode = 'PT409';
    end if;
    insert into public.tenancy_tenants (org_id, tenancy_id, tenant_id, is_primary) values (p_org, r.id, v_id, v_first)
    on conflict (tenancy_id, tenant_id) do nothing;
    v_first := false;
  end loop;
  return app.tenancy_summary(r.id);
end $$;

create or replace function public.update_tenancy(p_org uuid, p_tenancy uuid, p_expected_version int, p_start_date date,
  p_end_date date, p_rent_amount_minor bigint, p_rent_period public.rent_period, p_rent_due_day int,
  p_deposit_amount_minor bigint, p_deposit_scheme text, p_notice_days int, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_tenancy(p_org, p_tenancy, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status not in ('draft', 'active') then
    raise exception 'a % tenancy is read-only', r.status using errcode = 'PT409';
  end if;
  if r.status = 'active' then
    if p_start_date <> r.start_date then
      raise exception 'start date cannot change once a tenancy is active' using errcode = 'PT409';
    end if;
    perform app.require_role(p_org, 'manager');   -- changing live terms is a manager action
    perform 1 from public.units where id = r.unit_id for update;
    perform app.assert_no_overlap(r.unit_id, r.id, p_start_date, p_end_date);
  end if;
  update public.tenancies set start_date = p_start_date, end_date = p_end_date, rent_amount_minor = p_rent_amount_minor,
    rent_period = coalesce(p_rent_period, rent_period), rent_due_day = p_rent_due_day,
    deposit_amount_minor = coalesce(p_deposit_amount_minor, 0), deposit_scheme = nullif(trim(p_deposit_scheme), ''),
    notice_days = p_notice_days, notes = nullif(trim(p_notes), ''), version = version + 1
  where id = p_tenancy;
  return app.tenancy_summary(p_tenancy);
end $$;

create or replace function public.activate_tenancy(p_org uuid, p_tenancy uuid, p_expected_version int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies; u public.units;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_tenancy(p_org, p_tenancy, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status <> 'draft' then raise exception 'only draft tenancies can be activated' using errcode = 'PT409'; end if;
  -- Serialise activations per unit so two concurrent requests cannot both pass the overlap check.
  select * into u from public.units where id = r.unit_id for update;
  if u.archived_at is not null or (app.load_property(p_org, u.property_id)).archived_at is not null then
    raise exception 'unit or property is archived' using errcode = 'PT409';
  end if;
  if not exists (select 1 from public.tenancy_tenants where tenancy_id = r.id and is_primary) then
    raise exception 'a primary tenant is required' using errcode = 'PT409';
  end if;
  perform app.assert_no_overlap(r.unit_id, r.id, r.start_date, r.end_date);
  update public.tenancies set status = 'active', activated_at = now(), version = version + 1 where id = p_tenancy;
  return app.tenancy_summary(p_tenancy);
end $$;

create or replace function public.end_tenancy(p_org uuid, p_tenancy uuid, p_expected_version int,
  p_end_date date, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies; v_today date;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_tenancy(p_org, p_tenancy, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status <> 'active' then raise exception 'only active tenancies can be ended' using errcode = 'PT409'; end if;
  v_today := app.property_today((select property_id from public.units where id = r.unit_id));
  if p_end_date < r.start_date then raise exception 'end date is before the start date' using errcode = 'PT422'; end if;
  if p_end_date > v_today then
    raise exception 'a tenancy can only be ended on or before today; set a future end date by editing it instead'
      using errcode = 'PT422';
  end if;
  update public.tenancies set status = 'ended', end_date = p_end_date, end_reason = nullif(trim(p_reason), ''),
    ended_at = now(), version = version + 1 where id = p_tenancy;
  return app.tenancy_summary(p_tenancy);
end $$;

create or replace function public.cancel_tenancy(p_org uuid, p_tenancy uuid, p_expected_version int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_tenancy(p_org, p_tenancy, true);
  perform app.check_version(r.version, p_expected_version);
  if r.status <> 'draft' then raise exception 'only draft tenancies can be cancelled' using errcode = 'PT409'; end if;
  update public.tenancies set status = 'cancelled', end_reason = nullif(trim(p_reason), ''), version = version + 1
   where id = p_tenancy;
  return app.tenancy_summary(p_tenancy);
end $$;

create or replace function public.add_tenancy_tenant(p_org uuid, p_tenancy uuid, p_tenant uuid, p_is_primary boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_tenancy(p_org, p_tenancy, true);
  if r.status not in ('draft', 'active') then raise exception 'tenancy is closed' using errcode = 'PT409'; end if;
  if (app.load_tenant(p_org, p_tenant)).archived_at is not null then
    raise exception 'tenant is archived' using errcode = 'PT409';
  end if;
  if coalesce(p_is_primary, false) then
    update public.tenancy_tenants set is_primary = false where tenancy_id = p_tenancy and tenant_id <> p_tenant;
  end if;
  insert into public.tenancy_tenants (org_id, tenancy_id, tenant_id, is_primary)
  values (p_org, p_tenancy, p_tenant, coalesce(p_is_primary, false))
  on conflict (tenancy_id, tenant_id) do update set is_primary = public.tenancy_tenants.is_primary or excluded.is_primary;
  if not exists (select 1 from public.tenancy_tenants where tenancy_id = p_tenancy and is_primary) then
    update public.tenancy_tenants set is_primary = true
     where tenancy_id = p_tenancy and tenant_id = (select tenant_id from public.tenancy_tenants
       where tenancy_id = p_tenancy order by created_at limit 1);
  end if;
  update public.tenancies set version = version + 1 where id = p_tenancy;
  return public.get_tenancy(p_org, p_tenancy);
end $$;

create or replace function public.remove_tenancy_tenant(p_org uuid, p_tenancy uuid, p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.tenancies; v_primary boolean;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_tenancy(p_org, p_tenancy, true);
  if r.status not in ('draft', 'active') then raise exception 'tenancy is closed' using errcode = 'PT409'; end if;
  select is_primary into v_primary from public.tenancy_tenants where tenancy_id = p_tenancy and tenant_id = p_tenant;
  if v_primary is null then raise exception 'tenant is not on this tenancy' using errcode = 'PT404'; end if;
  if v_primary then raise exception 'make another tenant primary before removing this one' using errcode = 'PT409'; end if;
  delete from public.tenancy_tenants where tenancy_id = p_tenancy and tenant_id = p_tenant;
  update public.tenancies set version = version + 1 where id = p_tenancy;
  return public.get_tenancy(p_org, p_tenancy);
end $$;

create or replace function public.get_tenancy(p_org uuid, p_tenancy uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.tenancies;
begin
  perform app.require_role(p_org, 'viewer');
  r := app.load_tenancy(p_org, p_tenancy);
  return app.tenancy_summary(r.id) || jsonb_build_object(
    'unit_id', r.unit_id,
    'tenants', coalesce((select jsonb_agg(jsonb_build_object('tenant_id', te.id, 'full_name', te.full_name, 'email', te.email,
        'phone', te.phone, 'is_primary', tt.is_primary) order by tt.is_primary desc, te.full_name)
      from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id where tt.tenancy_id = r.id), '[]'::jsonb),
    'leases', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'start_date', l.start_date,
        'end_date', l.end_date, 'signed_on', l.signed_on, 'archived', l.archived_at is not null,
        'document_count', (select count(*) from public.lease_documents d where d.lease_id = l.id
                           and d.status = 'available' and d.archived_at is null and app.has_role(l.org_id, 'staff')))
        order by l.start_date desc) from public.leases l where l.tenancy_id = r.id), '[]'::jsonb));
end $$;

create or replace function public.list_tenancies(p_org uuid, p_search text default null, p_status public.tenancy_status default null,
  p_property uuid default null, p_unit uuid default null, p_tenant uuid default null, p_sort text default 'start',
  p_dir text default 'desc', p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'viewer');
  v_col := case p_sort when 'start' then 'start_date' when 'end' then 'end_date' when 'rent' then 'rent_amount_minor'
                       when 'status' then 'status' when 'property' then 'property_name' when 'tenant' then 'primary_tenant' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  execute format($q$
    with filtered as (
      select * from (
        select t.id, t.status, t.start_date, t.end_date, t.rent_amount_minor, t.rent_period, t.currency, t.unit_id,
          u.reference as unit_reference, pr.id as property_id, pr.name as property_name,
          (select te.full_name from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id
            where tt.tenancy_id = t.id and tt.is_primary) as primary_tenant
        from public.tenancies t join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id
        where t.org_id = $1 and ($2::public.tenancy_status is null or t.status = $2)
          and ($3::uuid is null or pr.id = $3) and ($4::uuid is null or t.unit_id = $4)
          and ($5::uuid is null or exists (select 1 from public.tenancy_tenants x where x.tenancy_id = t.id and x.tenant_id = $5))) y
      where $6::text is null or y.unit_reference ilike $6 or y.property_name ilike $6 or y.primary_tenant ilike $6)
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $7 offset $8) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_status, p_property, p_unit, p_tenant, app.like_pattern(p_search),
                   app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

-- ------------------------------------------------------------------- leases
create or replace function public.create_lease(p_org uuid, p_tenancy uuid, p_kind public.lease_kind, p_start_date date,
  p_end_date date, p_signed_on date, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenancies; r public.leases;
begin
  perform app.require_role(p_org, 'staff');
  t := app.load_tenancy(p_org, p_tenancy, true);
  if t.status = 'cancelled' then raise exception 'tenancy is cancelled' using errcode = 'PT409'; end if;
  insert into public.leases (org_id, tenancy_id, kind, start_date, end_date, signed_on, notes, created_by)
  values (p_org, p_tenancy, coalesce(p_kind, 'initial'), p_start_date, p_end_date, p_signed_on, nullif(trim(p_notes), ''), auth.uid())
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.update_lease(p_org uuid, p_lease uuid, p_expected_version int, p_kind public.lease_kind,
  p_start_date date, p_end_date date, p_signed_on date, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.leases;
begin
  perform app.require_role(p_org, 'staff');
  r := app.load_lease(p_org, p_lease, true);
  perform app.check_version(r.version, p_expected_version);
  if r.archived_at is not null then raise exception 'lease is archived' using errcode = 'PT409'; end if;
  update public.leases set kind = coalesce(p_kind, kind), start_date = p_start_date, end_date = p_end_date,
    signed_on = p_signed_on, notes = nullif(trim(p_notes), ''), version = version + 1
  where id = p_lease returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.get_lease(p_org uuid, p_lease uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.leases; v_can_docs boolean;
begin
  perform app.require_role(p_org, 'viewer');
  r := app.load_lease(p_org, p_lease);
  v_can_docs := app.has_role(p_org, 'staff');
  return to_jsonb(r) || jsonb_build_object(
    'tenancy', app.tenancy_summary(r.tenancy_id),
    'documents_visible', v_can_docs,
    'documents', case when not v_can_docs then '[]'::jsonb else coalesce((
       select jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'file_name', d.file_name,
         'mime_type', d.mime_type, 'size_bytes', d.size_bytes, 'status', d.status, 'created_at', d.created_at,
         'archived', d.archived_at is not null) order by d.created_at desc)
       from public.lease_documents d where d.lease_id = r.id and d.status = 'available'), '[]'::jsonb) end);
end $$;

create or replace function public.set_lease_archived(p_org uuid, p_lease uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.leases;
begin
  perform app.require_role(p_org, 'manager');
  r := app.load_lease(p_org, p_lease, true);
  update public.leases set archived_at = case when p_archived then now() end, version = version + 1
   where id = p_lease returning * into r;
  return to_jsonb(r);
end $$;

-- ---------------------------------------------------------------- documents
-- Step 1 of an upload: register metadata + path. Bytes go straight to Storage, which only accepts
-- paths that exist here as 'pending' (see storage policy).
create or replace function public.create_document(p_org uuid, p_lease uuid, p_doc_type public.document_type,
  p_file_name text, p_mime_type text, p_size_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.leases; v_id uuid := gen_random_uuid(); v_name text; r public.lease_documents;
begin
  perform app.require_role(p_org, 'staff');
  l := app.load_lease(p_org, p_lease);
  if l.archived_at is not null then raise exception 'lease is archived' using errcode = 'PT409'; end if;
  if p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document') then
    raise exception 'file type not allowed (PDF, PNG, JPEG or DOCX)' using errcode = 'PT422';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = 'PT422';
  end if;
  v_name := coalesce(nullif(regexp_replace(left(trim(p_file_name), 120), '[^A-Za-z0-9._-]+', '_', 'g'), ''), 'file');
  insert into public.lease_documents (id, org_id, lease_id, doc_type, file_name, mime_type, size_bytes, storage_path, uploaded_by)
  values (v_id, p_org, p_lease, coalesce(p_doc_type, 'lease'), left(trim(p_file_name), 200), p_mime_type, p_size_bytes,
          p_org || '/' || p_lease || '/' || v_id || '-' || v_name, auth.uid())
  returning * into r;
  return to_jsonb(r);
end $$;

-- Step 2: after the server has verified the object exists in Storage.
create or replace function public.confirm_document(p_org uuid, p_document uuid, p_size_bytes bigint, p_mime_type text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.lease_documents;
begin
  perform app.require_role(p_org, 'staff');
  select * into r from public.lease_documents where id = p_document and org_id = p_org for update;
  if r.id is null then raise exception 'document not found' using errcode = 'PT404'; end if;
  if r.uploaded_by <> auth.uid() and not app.has_role(p_org, 'manager') then
    raise exception 'only the uploader or a manager can confirm this upload' using errcode = 'PT403';
  end if;
  if r.status <> 'pending' then raise exception 'document already confirmed' using errcode = 'PT409'; end if;
  if p_size_bytes < 1 or p_size_bytes > 10485760 then raise exception 'file must be between 1 byte and 10 MB' using errcode = 'PT422'; end if;
  update public.lease_documents set status = 'available', size_bytes = p_size_bytes, mime_type = p_mime_type
   where id = p_document returning * into r;
  return to_jsonb(r);
end $$;

-- Used server-side before minting a short-lived download URL. Includes storage_path (never sent to browsers).
create or replace function public.get_document_access(p_org uuid, p_document uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.lease_documents;
begin
  perform app.require_role(p_org, 'staff');
  select * into r from public.lease_documents where id = p_document and org_id = p_org and status = 'available'
    and (archived_at is null or app.has_role(p_org, 'manager'));
  if r.id is null then raise exception 'document not found' using errcode = 'PT404'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.get_pending_document(p_org uuid, p_document uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.lease_documents;
begin
  perform app.require_role(p_org, 'staff');
  select * into r from public.lease_documents where id = p_document and org_id = p_org and status = 'pending';
  if r.id is null then raise exception 'document not found' using errcode = 'PT404'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.set_document_archived(p_org uuid, p_document uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.lease_documents;
begin
  perform app.require_role(p_org, 'manager');
  update public.lease_documents set archived_at = case when p_archived then now() end
   where id = p_document and org_id = p_org and status = 'available' returning * into r;
  if r.id is null then raise exception 'document not found' using errcode = 'PT404'; end if;
  return to_jsonb(r) - 'storage_path';
end $$;

-- ------------------------------------------------------------------- grants
revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
