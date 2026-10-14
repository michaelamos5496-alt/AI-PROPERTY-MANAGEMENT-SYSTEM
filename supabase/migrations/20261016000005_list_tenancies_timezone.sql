-- list_tenancies now also returns the property's IANA time zone so the UI can default dates to the property's local day.

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
        select t.id, t.status, t.start_date, t.end_date, t.rent_amount_minor, t.rent_period, t.currency, t.unit_id, pr.timezone,
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

revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
