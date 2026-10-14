-- Phase 8 (load test): the list queries called app.primary_tenant_name() once per row, and the balances list ran five subqueries per tenancy.
-- Same results, one join / one grouped pass instead.
create or replace view app.tenancy_primary as
select tt.tenancy_id, te.full_name from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id where tt.is_primary;

create or replace function public.list_charges(p_org uuid, p_tenancy uuid default null, p_property uuid default null, p_tenant uuid default null,
  p_currency text default null, p_search text default null, p_status text default null, p_from date default null, p_to date default null,
  p_sort text default 'due', p_dir text default 'desc', p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'staff');
  v_col := case p_sort when 'due' then 'due_date' when 'amount' then 'effective_minor' when 'outstanding' then 'outstanding_minor'
                       when 'property' then 'property_name' when 'tenant' then 'primary_tenant' when 'status' then 'status' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  if p_status is not null and p_status not in ('unpaid', 'partial', 'paid', 'overdue', 'void', 'waived') then
    raise exception 'invalid status filter' using errcode = 'PT422';
  end if;
  execute format($q$
    with filtered as (
      select cs.*, pr.name as property_name, un.reference as unit_reference, tp.full_name as primary_tenant
      from app.charge_state cs join public.properties pr on pr.id = cs.property_id join public.units un on un.id = cs.unit_id left join app.tenancy_primary tp on tp.tenancy_id = cs.tenancy_id
      where cs.org_id = $1 and ($2::uuid is null or cs.tenancy_id = $2) and ($3::uuid is null or cs.property_id = $3)
        and ($4::uuid is null or exists (select 1 from public.tenancy_tenants tt where tt.tenancy_id = cs.tenancy_id and tt.tenant_id = $4))
        and ($5::text is null or cs.currency = $5) and ($8::date is null or cs.due_date >= $8) and ($9::date is null or cs.due_date <= $9)
        and ($6::text is null or ($6 = 'overdue' and cs.is_overdue) or ($6 <> 'overdue' and cs.status = $6))
        and ($12::text is null or cs.description ilike $12 or pr.name ilike $12 or un.reference ilike $12 or tp.full_name ilike $12))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'charged_minor', ch, 'allocated_minor', al, 'outstanding_minor', ou, 'overdue_minor', od) order by currency)
                          from (select currency, sum(effective_minor) filter (where voided_at is null) ch, sum(allocated_minor) filter (where voided_at is null) al,
                                       sum(outstanding_minor) ou, sum(outstanding_minor) filter (where is_overdue) od from filtered group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $10 offset $11) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_tenancy, p_property, p_tenant, upper(p_currency), p_status, null::int, p_from, p_to, app.page_limit(p_limit), app.page_offset(p_offset), app.like_pattern(p_search);
  return v_out;
end $$;

create or replace function public.list_payments(p_org uuid, p_tenancy uuid default null, p_property uuid default null, p_tenant uuid default null,
  p_currency text default null, p_search text default null, p_status text default null, p_from date default null, p_to date default null,
  p_sort text default 'received', p_dir text default 'desc', p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'staff');
  v_col := case p_sort when 'received' then 'received_on' when 'amount' then 'amount_minor' when 'unallocated' then 'unallocated_minor'
                       when 'property' then 'property_name' when 'tenant' then 'primary_tenant' when 'status' then 'status' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  if p_status is not null and p_status not in ('unallocated', 'partial', 'allocated', 'reversed') then
    raise exception 'invalid status filter' using errcode = 'PT422';
  end if;
  execute format($q$
    with filtered as (
      select ps.*, pr.name as property_name, un.reference as unit_reference, tp.full_name as primary_tenant,
             (select r.number from public.receipts r where r.payment_id = ps.id and r.voided_at is null) as receipt_number
      from app.payment_state ps join public.properties pr on pr.id = ps.property_id join public.units un on un.id = ps.unit_id left join app.tenancy_primary tp on tp.tenancy_id = ps.tenancy_id
      where ps.org_id = $1 and ($2::uuid is null or ps.tenancy_id = $2) and ($3::uuid is null or ps.property_id = $3)
        and ($4::uuid is null or ps.tenant_id = $4 or exists (select 1 from public.tenancy_tenants tt where tt.tenancy_id = ps.tenancy_id and tt.tenant_id = $4))
        and ($5::text is null or ps.currency = $5) and ($6::text is null or ps.status = $6)
        and ($7::date is null or ps.received_on >= $7) and ($8::date is null or ps.received_on <= $8)
        and ($11::text is null or ps.reference ilike $11 or ps.note ilike $11 or tp.full_name ilike $11 or pr.name ilike $11 or un.reference ilike $11))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'received_minor', rc, 'allocated_minor', al, 'unallocated_minor', un) order by currency)
                          from (select currency, sum(amount_minor) filter (where reversed_at is null) rc, sum(allocated_minor) filter (where reversed_at is null) al,
                                       sum(unallocated_minor) un from filtered group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $9 offset $10) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_tenancy, p_property, p_tenant, upper(p_currency), p_status, p_from, p_to, app.page_limit(p_limit), app.page_offset(p_offset), app.like_pattern(p_search);
  return v_out;
end $$;

create or replace function public.list_tenant_balances(p_org uuid, p_property uuid default null, p_currency text default null, p_search text default null,
  p_from date default null, p_to date default null, p_arrears_only boolean default false, p_sort text default 'outstanding', p_dir text default 'desc',
  p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'staff');
  v_col := case p_sort when 'outstanding' then 'outstanding_minor' when 'overdue' then 'overdue_minor' when 'tenant' then 'primary_tenant'
                       when 'property' then 'property_name' when 'credit' then 'credit_minor' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  execute format($q$
    with cs as (
      select c.tenancy_id,
             sum(c.effective_minor) filter (where c.voided_at is null) as ch, sum(c.allocated_minor) filter (where c.voided_at is null) as al,
             sum(c.outstanding_minor) as ou, sum(c.outstanding_minor) filter (where c.is_overdue) as od
        from app.charge_state c where c.org_id = $1 and ($5::date is null or c.due_date >= $5) and ($6::date is null or c.due_date <= $6) group by c.tenancy_id),
    pay as (select p.tenancy_id, sum(p.unallocated_minor) as cr from app.payment_state p where p.org_id = $1 group by p.tenancy_id),
    per as (
      select t.id as tenancy_id, t.status as tenancy_status, t.currency, pr.id as property_id, pr.name as property_name, un.id as unit_id, un.reference as unit_reference,
             tp.full_name as primary_tenant, coalesce(cs.ch, 0)::bigint as charged_minor, coalesce(cs.al, 0)::bigint as allocated_minor,
             coalesce(cs.ou, 0)::bigint as outstanding_minor, coalesce(cs.od, 0)::bigint as overdue_minor, coalesce(pay.cr, 0)::bigint as credit_minor
      from public.tenancies t join public.units un on un.id = t.unit_id join public.properties pr on pr.id = un.property_id
        left join app.tenancy_primary tp on tp.tenancy_id = t.id left join cs on cs.tenancy_id = t.id left join pay on pay.tenancy_id = t.id
      where t.org_id = $1 and t.status <> 'cancelled' and ($2::uuid is null or pr.id = $2) and ($3::text is null or t.currency = $3)
        and (exists (select 1 from public.charges c where c.tenancy_id = t.id) or exists (select 1 from public.payments p where p.tenancy_id = t.id))),
    filtered as (select * from per where ($4::text is null or primary_tenant ilike $4 or property_name ilike $4 or unit_reference ilike $4)
                   and (not $7 or overdue_minor > 0))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'charged_minor', ch, 'outstanding_minor', ou, 'overdue_minor', od, 'credit_minor', cr) order by currency)
                          from (select currency, sum(charged_minor) ch, sum(outstanding_minor) ou, sum(overdue_minor) od, sum(credit_minor) cr from filtered group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, tenancy_id limit $8 offset $9) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_property, upper(p_currency), app.like_pattern(p_search), p_from, p_to, coalesce(p_arrears_only, false), app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('list_charges', 'list_payments', 'list_tenant_balances') loop
    execute format('revoke execute on function %s from public, anon', r.f); execute format('grant execute on function %s to authenticated', r.f);
  end loop;
end $$;
