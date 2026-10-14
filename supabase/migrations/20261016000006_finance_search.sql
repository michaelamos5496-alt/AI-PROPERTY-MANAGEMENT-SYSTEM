-- Adds free-text search to the charge, payment and expense lists. A new parameter changes the function signature,
-- so the previous overloads are dropped first (otherwise calls with omitted arguments would be ambiguous).
drop function if exists public.list_charges(uuid, uuid, uuid, uuid, text, text, date, date, text, text, integer, integer);
drop function if exists public.list_payments(uuid, uuid, uuid, uuid, text, text, date, date, text, text, integer, integer);
drop function if exists public.list_expenses(uuid, uuid, public.expense_category, text, date, date, boolean, text, text, integer, integer);

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
      select cs.*, pr.name as property_name, un.reference as unit_reference, app.primary_tenant_name(cs.tenancy_id) as primary_tenant
      from app.charge_state cs join public.properties pr on pr.id = cs.property_id join public.units un on un.id = cs.unit_id
      where cs.org_id = $1 and ($2::uuid is null or cs.tenancy_id = $2) and ($3::uuid is null or cs.property_id = $3)
        and ($4::uuid is null or exists (select 1 from public.tenancy_tenants tt where tt.tenancy_id = cs.tenancy_id and tt.tenant_id = $4))
        and ($5::text is null or cs.currency = $5) and ($8::date is null or cs.due_date >= $8) and ($9::date is null or cs.due_date <= $9)
        and ($6::text is null or ($6 = 'overdue' and cs.is_overdue) or ($6 <> 'overdue' and cs.status = $6))
        and ($12::text is null or cs.description ilike $12 or pr.name ilike $12 or un.reference ilike $12 or app.primary_tenant_name(cs.tenancy_id) ilike $12))
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
      select ps.*, pr.name as property_name, un.reference as unit_reference, app.primary_tenant_name(ps.tenancy_id) as primary_tenant,
             (select r.number from public.receipts r where r.payment_id = ps.id and r.voided_at is null) as receipt_number
      from app.payment_state ps join public.properties pr on pr.id = ps.property_id join public.units un on un.id = ps.unit_id
      where ps.org_id = $1 and ($2::uuid is null or ps.tenancy_id = $2) and ($3::uuid is null or ps.property_id = $3)
        and ($4::uuid is null or ps.tenant_id = $4 or exists (select 1 from public.tenancy_tenants tt where tt.tenancy_id = ps.tenancy_id and tt.tenant_id = $4))
        and ($5::text is null or ps.currency = $5) and ($6::text is null or ps.status = $6)
        and ($7::date is null or ps.received_on >= $7) and ($8::date is null or ps.received_on <= $8)
        and ($11::text is null or ps.reference ilike $11 or ps.note ilike $11 or app.primary_tenant_name(ps.tenancy_id) ilike $11 or pr.name ilike $11 or un.reference ilike $11))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'received_minor', rc, 'allocated_minor', al, 'unallocated_minor', un) order by currency)
                          from (select currency, sum(amount_minor) filter (where reversed_at is null) rc, sum(allocated_minor) filter (where reversed_at is null) al,
                                       sum(unallocated_minor) un from filtered group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $9 offset $10) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_tenancy, p_property, p_tenant, upper(p_currency), p_status, p_from, p_to, app.page_limit(p_limit), app.page_offset(p_offset), app.like_pattern(p_search);
  return v_out;
end $$;

create or replace function public.list_expenses(p_org uuid, p_property uuid default null, p_category public.expense_category default null,
  p_currency text default null, p_search text default null, p_from date default null, p_to date default null, p_include_void boolean default false,
  p_sort text default 'date', p_dir text default 'desc', p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_col text; v_out jsonb;
begin
  perform app.require_role(p_org, 'staff');
  v_col := case p_sort when 'date' then 'incurred_on' when 'amount' then 'amount_minor' when 'property' then 'property_name' when 'category' then 'category' end;
  if v_col is null then raise exception 'invalid sort' using errcode = 'PT422'; end if;
  execute format($q$
    with filtered as (
      select e.id, e.property_id, pr.name as property_name, e.unit_id, un.reference as unit_reference, e.currency, e.category, e.description, e.vendor, e.reference,
             e.amount_minor, e.incurred_on, e.voided_at, e.void_reason, e.created_at
      from public.expenses e join public.properties pr on pr.id = e.property_id left join public.units un on un.id = e.unit_id
      where e.org_id = $1 and ($2::uuid is null or e.property_id = $2) and ($3::public.expense_category is null or e.category = $3)
        and ($4::text is null or e.currency = $4) and ($5::date is null or e.incurred_on >= $5) and ($6::date is null or e.incurred_on <= $6)
        and ($7 or e.voided_at is null)
        and ($10::text is null or e.description ilike $10 or e.vendor ilike $10 or e.reference ilike $10 or pr.name ilike $10))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', s) order by currency)
                          from (select currency, sum(amount_minor) s from filtered where voided_at is null group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $8 offset $9) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_property, p_category, upper(p_currency), p_from, p_to, coalesce(p_include_void, false), app.page_limit(p_limit), app.page_offset(p_offset), app.like_pattern(p_search);
  return v_out;
end $$;

revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
