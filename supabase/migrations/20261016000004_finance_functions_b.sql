-- Phase 3 functions, part B: receipts, expenses, reads, reports, reconciliation.

-- ----------------------------------------------------------------- receipts
create or replace function app.next_counter(p_org uuid, p_name text) returns bigint
language sql security definer set search_path = '' as $$
  insert into public.org_counters (org_id, name, value) values (p_org, p_name, 1)
  on conflict (org_id, name) do update set value = public.org_counters.value + 1 returning value $$;

create or replace function public.issue_receipt(p_org uuid, p_payment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.payments; r public.receipts; v_seq bigint; v_snap jsonb; v_payer text; v_by text;
begin
  perform app.require_role(p_org, 'staff');
  select * into p from public.payments where id = p_payment and org_id = p_org for update;     -- serialises concurrent issues
  if p.id is null then raise exception 'payment not found' using errcode = 'PT404'; end if;
  select * into r from public.receipts where payment_id = p_payment;
  if r.id is not null then return jsonb_build_object('id', r.id, 'number', r.number, 'issued_at', r.issued_at, 'voided_at', r.voided_at, 'replayed', true); end if;
  if p.reversed_at is not null then raise exception 'a reversed payment cannot be receipted' using errcode = 'PT409'; end if;

  v_seq := app.next_counter(p_org, 'receipt');
  select coalesce((select te.full_name from public.tenants te where te.id = p.tenant_id),
                  (select te.full_name from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id
                    where tt.tenancy_id = p.tenancy_id and tt.is_primary)) into v_payer;
  select coalesce(nullif(pr.full_name, ''), pr.email) into v_by from public.profiles pr where pr.id = p.created_by;
  v_snap := jsonb_build_object(
    'organization', (select name from public.organizations where id = p_org),
    'number', 'R-' || lpad(v_seq::text, 6, '0'),
    'payment', jsonb_build_object('id', p.id, 'amount_minor', p.amount_minor, 'currency', p.currency, 'received_on', p.received_on,
                                  'method', p.method, 'reference', p.reference, 'note', p.note),
    'received_from', v_payer,
    'recorded_by', v_by,
    'property', (select jsonb_build_object('name', pr.name, 'address', concat_ws(', ', pr.address_line1, pr.city, pr.region, pr.postal_code, pr.country), 'unit', u.reference)
                   from public.tenancies t join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id where t.id = p.tenancy_id),
    'applied_to', coalesce((select jsonb_agg(jsonb_build_object('charge', c.description, 'due_date', c.due_date, 'amount_minor', a.amount_minor) order by c.due_date, a.created_at)
                              from public.payment_allocations a join public.charges c on c.id = a.charge_id
                             where a.payment_id = p.id and a.reversed_at is null), '[]'::jsonb),
    'unallocated_minor', (select unallocated_minor from app.payment_state where id = p.id),
    'verification', 'manual_unverified',
    'notice', 'Recorded manually by staff. This receipt is not verified against a bank or payment provider.');
  insert into public.receipts (org_id, payment_id, seq, number, snapshot, issued_by)
  values (p_org, p_payment, v_seq, v_snap ->> 'number', v_snap, auth.uid()) returning * into r;
  perform app.audit(p_org, 'receipt.issued', 'payment', p_payment, null, jsonb_build_object('receipt_id', r.id, 'number', r.number));
  return jsonb_build_object('id', r.id, 'number', r.number, 'issued_at', r.issued_at, 'voided_at', null, 'replayed', false);
end $$;

create or replace function public.get_receipt(p_org uuid, p_receipt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.receipts;
begin
  perform app.require_role(p_org, 'staff');
  select * into r from public.receipts where id = p_receipt and org_id = p_org;
  if r.id is null then raise exception 'receipt not found' using errcode = 'PT404'; end if;
  return jsonb_build_object('id', r.id, 'number', r.number, 'payment_id', r.payment_id, 'snapshot', r.snapshot, 'issued_at', r.issued_at,
    'voided_at', r.voided_at, 'void_reason', r.void_reason,
    'issued_by', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = r.issued_by));
end $$;

-- ----------------------------------------------------------------- expenses
create or replace function public.record_expense(p_org uuid, p_property uuid, p_unit uuid, p_category public.expense_category,
  p_description text, p_vendor text, p_reference text, p_amount_minor bigint, p_incurred_on date, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pr public.properties; v_id uuid; r public.expenses;
begin
  perform app.require_role(p_org, 'manager');
  pr := app.load_property(p_org, p_property);
  if pr.archived_at is not null then raise exception 'property is archived' using errcode = 'PT409'; end if;
  if p_unit is not null and not exists (select 1 from public.units where id = p_unit and property_id = p_property and org_id = p_org) then
    raise exception 'unit does not belong to this property' using errcode = 'PT422';
  end if;
  if p_incurred_on > app.property_today(p_property) then raise exception 'the expense date cannot be in the future' using errcode = 'PT422'; end if;
  insert into public.expenses (org_id, property_id, unit_id, currency, category, description, vendor, reference, amount_minor, incurred_on, idempotency_key, created_by)
  values (p_org, p_property, p_unit, pr.currency, p_category, btrim(p_description), nullif(btrim(p_vendor), ''), nullif(btrim(p_reference), ''),
          p_amount_minor, p_incurred_on, p_idempotency_key, auth.uid())
  on conflict (org_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select * into r from public.expenses where org_id = p_org and idempotency_key = p_idempotency_key;
    if r.property_id <> p_property or r.amount_minor <> p_amount_minor or r.incurred_on <> p_incurred_on then
      raise exception 'idempotency key was already used for a different expense' using errcode = 'PT409';
    end if;
    return to_jsonb(r) - 'idempotency_key' || jsonb_build_object('replayed', true);
  end if;
  select * into r from public.expenses where id = v_id;
  perform app.audit(p_org, 'expense.recorded', 'expense', v_id, null, to_jsonb(r) - 'idempotency_key');
  return to_jsonb(r) - 'idempotency_key' || jsonb_build_object('replayed', false);
end $$;

create or replace function public.void_expense(p_org uuid, p_expense uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.expenses; v_before jsonb;
begin
  perform app.require_role(p_org, 'manager');
  select * into r from public.expenses where id = p_expense and org_id = p_org for update;
  if r.id is null then raise exception 'expense not found' using errcode = 'PT404'; end if;
  if r.voided_at is not null then return to_jsonb(r) - 'idempotency_key'; end if;
  v_before := to_jsonb(r) - 'idempotency_key';
  update public.expenses set voided_at = now(), voided_by = auth.uid(), void_reason = app.require_reason(p_reason) where id = p_expense returning * into r;
  perform app.audit(p_org, 'expense.voided', 'expense', p_expense, v_before, to_jsonb(r) - 'idempotency_key', btrim(p_reason));
  return to_jsonb(r) - 'idempotency_key';
end $$;

-- -------------------------------------------------------------------- reads
create or replace function app.primary_tenant_name(p_tenancy uuid) returns text
language sql stable security definer set search_path = '' as $$
  select te.full_name from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id where tt.tenancy_id = p_tenancy and tt.is_primary $$;

create or replace function public.list_charges(p_org uuid, p_tenancy uuid default null, p_property uuid default null, p_tenant uuid default null,
  p_currency text default null, p_status text default null, p_from date default null, p_to date default null,
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
        and ($6::text is null or ($6 = 'overdue' and cs.is_overdue) or ($6 <> 'overdue' and cs.status = $6)))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'charged_minor', ch, 'allocated_minor', al, 'outstanding_minor', ou, 'overdue_minor', od) order by currency)
                          from (select currency, sum(effective_minor) filter (where voided_at is null) ch, sum(allocated_minor) filter (where voided_at is null) al,
                                       sum(outstanding_minor) ou, sum(outstanding_minor) filter (where is_overdue) od from filtered group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $10 offset $11) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_tenancy, p_property, p_tenant, upper(p_currency), p_status, null::int, p_from, p_to, app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

create or replace function public.list_payments(p_org uuid, p_tenancy uuid default null, p_property uuid default null, p_tenant uuid default null,
  p_currency text default null, p_status text default null, p_from date default null, p_to date default null,
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
        and ($7::date is null or ps.received_on >= $7) and ($8::date is null or ps.received_on <= $8))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'received_minor', rc, 'allocated_minor', al, 'unallocated_minor', un) order by currency)
                          from (select currency, sum(amount_minor) filter (where reversed_at is null) rc, sum(allocated_minor) filter (where reversed_at is null) al,
                                       sum(unallocated_minor) un from filtered group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $9 offset $10) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_tenancy, p_property, p_tenant, upper(p_currency), p_status, p_from, p_to, app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

create or replace function public.get_payment(p_org uuid, p_payment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_role(p_org, 'staff');
  v := app.payment_json(p_org, p_payment);
  if v is null then raise exception 'payment not found' using errcode = 'PT404'; end if;
  return v || jsonb_build_object(
    'tenancy', (select jsonb_build_object('id', t.id, 'status', t.status, 'unit_reference', u.reference, 'property_name', pr.name, 'timezone', pr.timezone,
                  'primary_tenant', app.primary_tenant_name(t.id)) from public.tenancies t join public.units u on u.id = t.unit_id
                  join public.properties pr on pr.id = u.property_id where t.id = (v ->> 'tenancy_id')::uuid),
    'receipt', (select jsonb_build_object('id', r.id, 'number', r.number, 'voided_at', r.voided_at) from public.receipts r where r.payment_id = p_payment),
    'recorded_by', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = (v ->> 'created_by')::uuid),
    'history', case when app.has_role(p_org, 'manager') then coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'created_at', a.created_at,
                  'reason', a.reason, 'actor', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = a.actor_id), 'after', a.after_state, 'before', a.before_state) order by a.id)
                from public.finance_audit a where a.org_id = p_org and a.entity_type = 'payment' and a.entity_id = p_payment), '[]'::jsonb) else null end);
end $$;

create or replace function public.get_tenancy_ledger(p_org uuid, p_tenancy uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tenancies; v_sum jsonb;
begin
  perform app.require_role(p_org, 'staff');
  t := app.load_tenancy(p_org, p_tenancy);
  select jsonb_build_object(
    'currency', t.currency,
    'charged_minor', coalesce(sum(effective_minor) filter (where voided_at is null), 0),
    'allocated_minor', coalesce(sum(allocated_minor) filter (where voided_at is null), 0),
    'outstanding_minor', coalesce(sum(outstanding_minor), 0),
    'overdue_minor', coalesce(sum(outstanding_minor) filter (where is_overdue), 0)) into v_sum
  from app.charge_state where tenancy_id = p_tenancy;
  v_sum := v_sum || jsonb_build_object('credit_minor', coalesce((select sum(unallocated_minor) from app.payment_state where tenancy_id = p_tenancy), 0));
  v_sum := v_sum || jsonb_build_object('net_minor', (v_sum ->> 'outstanding_minor')::bigint - (v_sum ->> 'credit_minor')::bigint);
  return jsonb_build_object('tenancy_id', p_tenancy, 'currency', t.currency, 'summary', v_sum,
    'schedules', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc) from public.rent_schedules s where s.tenancy_id = p_tenancy), '[]'::jsonb),
    'charges', coalesce((select jsonb_agg(to_jsonb(c) order by c.due_date desc, c.created_at desc) from app.charge_state c where c.tenancy_id = p_tenancy), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.received_on desc, p.created_at desc) from app.payment_state p where p.tenancy_id = p_tenancy), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'charge_id', a.charge_id, 'amount_minor', a.amount_minor, 'reason', a.reason, 'created_at', a.created_at,
        'by', (select coalesce(nullif(full_name, ''), email) from public.profiles where id = a.created_by)) order by a.created_at desc)
        from public.charge_adjustments a where a.tenancy_id = p_tenancy), '[]'::jsonb));
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
    with per as (
      select t.id as tenancy_id, t.status as tenancy_status, t.currency, pr.id as property_id, pr.name as property_name, un.id as unit_id, un.reference as unit_reference,
             app.primary_tenant_name(t.id) as primary_tenant,
             coalesce((select sum(effective_minor) from app.charge_state c where c.tenancy_id = t.id and c.voided_at is null and ($5::date is null or c.due_date >= $5) and ($6::date is null or c.due_date <= $6)), 0)::bigint as charged_minor,
             coalesce((select sum(allocated_minor) from app.charge_state c where c.tenancy_id = t.id and c.voided_at is null and ($5::date is null or c.due_date >= $5) and ($6::date is null or c.due_date <= $6)), 0)::bigint as allocated_minor,
             coalesce((select sum(outstanding_minor) from app.charge_state c where c.tenancy_id = t.id and ($5::date is null or c.due_date >= $5) and ($6::date is null or c.due_date <= $6)), 0)::bigint as outstanding_minor,
             coalesce((select sum(outstanding_minor) from app.charge_state c where c.tenancy_id = t.id and c.is_overdue and ($5::date is null or c.due_date >= $5) and ($6::date is null or c.due_date <= $6)), 0)::bigint as overdue_minor,
             coalesce((select sum(unallocated_minor) from app.payment_state p where p.tenancy_id = t.id), 0)::bigint as credit_minor
      from public.tenancies t join public.units un on un.id = t.unit_id join public.properties pr on pr.id = un.property_id
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

-- Per property and currency. Currencies are never combined into one figure.
-- collection_rate_bps = collected * 10000 / billed, integer floor (basis points): no floating point.
create or replace function public.property_performance(p_org uuid, p_from date, p_to date, p_property uuid default null, p_currency text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'choose a valid period' using errcode = 'PT422'; end if;
  if p_to - p_from > 1830 then raise exception 'the period can be at most 5 years' using errcode = 'PT422'; end if;
  return coalesce((
    with keys as (
      select property_id, currency from app.charge_state where org_id = p_org and due_date between p_from and p_to
      union select property_id, currency from app.payment_state where org_id = p_org and received_on between p_from and p_to
      union select property_id, currency from public.expenses where org_id = p_org and incurred_on between p_from and p_to),
    rows_ as (
      select k.property_id, pr.name as property_name, k.currency,
        coalesce((select sum(effective_minor) from app.charge_state c where c.property_id = k.property_id and c.currency = k.currency and c.voided_at is null and c.due_date between p_from and p_to), 0)::bigint as billed_minor,
        coalesce((select sum(allocated_minor) from app.charge_state c where c.property_id = k.property_id and c.currency = k.currency and c.voided_at is null and c.due_date between p_from and p_to), 0)::bigint as collected_minor,
        coalesce((select sum(outstanding_minor) from app.charge_state c where c.property_id = k.property_id and c.currency = k.currency and c.due_date between p_from and p_to), 0)::bigint as outstanding_minor,
        coalesce((select sum(outstanding_minor) from app.charge_state c where c.property_id = k.property_id and c.currency = k.currency and c.is_overdue and c.due_date between p_from and p_to), 0)::bigint as overdue_minor,
        coalesce((select sum(amount_minor) from app.payment_state p where p.property_id = k.property_id and p.currency = k.currency and p.reversed_at is null and p.received_on between p_from and p_to), 0)::bigint as payments_received_minor,
        coalesce((select sum(amount_minor) from public.expenses e where e.property_id = k.property_id and e.currency = k.currency and e.voided_at is null and e.incurred_on between p_from and p_to), 0)::bigint as expenses_minor
      from keys k join public.properties pr on pr.id = k.property_id
      where (p_property is null or k.property_id = p_property) and (p_currency is null or k.currency = upper(p_currency)))
    select jsonb_agg(to_jsonb(r) || jsonb_build_object(
        'collection_rate_bps', case when billed_minor = 0 then null else (collected_minor * 10000) / billed_minor end,
        'net_cash_minor', payments_received_minor - expenses_minor) order by property_name, currency)
    from rows_ r), '[]'::jsonb);
end $$;

create or replace function public.list_expenses(p_org uuid, p_property uuid default null, p_category public.expense_category default null,
  p_currency text default null, p_from date default null, p_to date default null, p_include_void boolean default false,
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
        and ($7 or e.voided_at is null))
    select jsonb_build_object('total', (select count(*) from filtered),
      'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', s) order by currency)
                          from (select currency, sum(amount_minor) s from filtered where voided_at is null group by currency) g), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(f)) from (select * from filtered order by %I %s nulls last, id limit $8 offset $9) f), '[]'::jsonb))
  $q$, v_col, app.sort_dir(p_dir))
  into v_out using p_org, p_property, p_category, upper(p_currency), p_from, p_to, coalesce(p_include_void, false), app.page_limit(p_limit), app.page_offset(p_offset);
  return v_out;
end $$;

create or replace function public.list_finance_audit(p_org uuid, p_entity_type text default null, p_entity_id uuid default null,
  p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return (with filtered as (
      select a.*, (select coalesce(nullif(full_name, ''), email) from public.profiles where id = a.actor_id) as actor_name
      from public.finance_audit a where a.org_id = p_org and (p_entity_type is null or a.entity_type = p_entity_type) and (p_entity_id is null or a.entity_id = p_entity_id))
    select jsonb_build_object('total', (select count(*) from filtered),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'action', f.action, 'entity_type', f.entity_type, 'entity_id', f.entity_id, 'actor', f.actor_name,
          'reason', f.reason, 'before', f.before_state, 'after', f.after_state, 'created_at', f.created_at))
        from (select * from filtered order by id desc limit app.page_limit(p_limit) offset app.page_offset(p_offset)) f), '[]'::jsonb)));
end $$;

-- ------------------------------------------------------------ reconciliation
-- Recomputes every invariant from the raw ledger rows (not from the views) and reports any disagreement.
create or replace function public.reconcile_finance(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_checks jsonb := '[]'::jsonb; v_n bigint; v_ok boolean := true; v_totals jsonb;
begin
  perform app.require_role(p_org, 'manager');

  select count(*) into v_n from public.payments p where p.org_id = p_org and p.reversed_at is null
     and (select coalesce(sum(a.amount_minor), 0) from public.payment_allocations a where a.payment_id = p.id and a.reversed_at is null) > p.amount_minor;
  v_checks := v_checks || jsonb_build_object('name', 'No payment is allocated beyond its amount', 'ok', v_n = 0, 'violations', v_n);

  select count(*) into v_n from public.charges c where c.org_id = p_org and c.voided_at is null
     and (select coalesce(sum(a.amount_minor), 0) from public.payment_allocations a where a.charge_id = c.id and a.reversed_at is null)
       > c.amount_minor + (select coalesce(sum(j.amount_minor), 0) from public.charge_adjustments j where j.charge_id = c.id);
  v_checks := v_checks || jsonb_build_object('name', 'No charge is paid beyond what is owed', 'ok', v_n = 0, 'violations', v_n);

  select count(*) into v_n from public.charges c where c.org_id = p_org
     and c.amount_minor + (select coalesce(sum(j.amount_minor), 0) from public.charge_adjustments j where j.charge_id = c.id) < 0;
  v_checks := v_checks || jsonb_build_object('name', 'No charge is negative after adjustments', 'ok', v_n = 0, 'violations', v_n);

  select count(*) into v_n from public.payment_allocations a join public.payments p on p.id = a.payment_id join public.charges c on c.id = a.charge_id
   where a.org_id = p_org and (a.currency <> p.currency or a.currency <> c.currency or p.tenancy_id <> c.tenancy_id or a.tenancy_id <> p.tenancy_id);
  v_checks := v_checks || jsonb_build_object('name', 'Every allocation matches its payment and charge in currency and tenancy', 'ok', v_n = 0, 'violations', v_n);

  select count(*) into v_n from public.payment_allocations a join public.charges c on c.id = a.charge_id where a.org_id = p_org and a.reversed_at is null and c.voided_at is not null;
  v_checks := v_checks || jsonb_build_object('name', 'No active allocation sits on a void charge', 'ok', v_n = 0, 'violations', v_n);

  select count(*) into v_n from public.payment_allocations a join public.payments p on p.id = a.payment_id where a.org_id = p_org and a.reversed_at is null and p.reversed_at is not null;
  v_checks := v_checks || jsonb_build_object('name', 'No active allocation sits on a reversed payment', 'ok', v_n = 0, 'violations', v_n);

  select count(*) into v_n from public.receipts r join public.payments p on p.id = r.payment_id where r.org_id = p_org and p.reversed_at is not null and r.voided_at is null;
  v_checks := v_checks || jsonb_build_object('name', 'Receipts of reversed payments are void', 'ok', v_n = 0, 'violations', v_n);

  -- Per currency: totals from raw rows must equal totals from the derived views.
  with raw as (
    select cur.currency,
      (select coalesce(sum(c.amount_minor), 0) from public.charges c where c.org_id = p_org and c.currency = cur.currency and c.voided_at is null)
        + (select coalesce(sum(j.amount_minor), 0) from public.charge_adjustments j join public.charges c on c.id = j.charge_id where j.org_id = p_org and c.currency = cur.currency and c.voided_at is null) as charged,
      (select coalesce(sum(a.amount_minor), 0) from public.payment_allocations a join public.charges c on c.id = a.charge_id where a.org_id = p_org and c.currency = cur.currency and c.voided_at is null and a.reversed_at is null) as allocated,
      (select coalesce(sum(p.amount_minor), 0) from public.payments p where p.org_id = p_org and p.currency = cur.currency and p.reversed_at is null) as paid,
      (select coalesce(sum(a.amount_minor), 0) from public.payment_allocations a join public.payments p on p.id = a.payment_id where a.org_id = p_org and p.currency = cur.currency and p.reversed_at is null and a.reversed_at is null) as paid_allocated
    from (select distinct currency from public.charges where org_id = p_org union select distinct currency from public.payments where org_id = p_org) cur),
  derived as (
    select currency, sum(effective_minor) filter (where voided_at is null) as charged, sum(allocated_minor) filter (where voided_at is null) as allocated, sum(outstanding_minor) as outstanding
    from app.charge_state where org_id = p_org group by currency),
  dpay as (select currency, sum(amount_minor) filter (where reversed_at is null) as paid, sum(unallocated_minor) as credit from app.payment_state where org_id = p_org group by currency)
  select coalesce(jsonb_agg(jsonb_build_object('currency', raw.currency, 'charged_minor', raw.charged, 'allocated_minor', raw.allocated,
           'outstanding_minor', raw.charged - raw.allocated, 'payments_minor', raw.paid, 'credit_minor', raw.paid - raw.paid_allocated,
           'matches_views', (coalesce(d.charged, 0) = raw.charged and coalesce(d.allocated, 0) = raw.allocated and coalesce(d.outstanding, 0) = raw.charged - raw.allocated
                             and coalesce(dp.paid, 0) = raw.paid and coalesce(dp.credit, 0) = raw.paid - raw.paid_allocated),
           'within_safe_integer', greatest(abs(raw.charged), abs(raw.paid), abs(raw.allocated)) <= 9007199254740991) order by raw.currency), '[]'::jsonb)
    into v_totals
  from raw left join derived d on d.currency = raw.currency left join dpay dp on dp.currency = raw.currency;

  v_checks := v_checks || jsonb_build_object('name', 'Balances derived from the ledger equal the sums of the raw rows (per currency)',
    'ok', not exists (select 1 from jsonb_array_elements(v_totals) t where not (t ->> 'matches_views')::boolean), 'violations',
    (select count(*) from jsonb_array_elements(v_totals) t where not (t ->> 'matches_views')::boolean));
  v_checks := v_checks || jsonb_build_object('name', 'All totals fit exactly in a JavaScript number',
    'ok', not exists (select 1 from jsonb_array_elements(v_totals) t where not (t ->> 'within_safe_integer')::boolean), 'violations',
    (select count(*) from jsonb_array_elements(v_totals) t where not (t ->> 'within_safe_integer')::boolean));

  select bool_and((c ->> 'ok')::boolean) into v_ok from jsonb_array_elements(v_checks) c;
  return jsonb_build_object('ok', coalesce(v_ok, true), 'checked_at', now(), 'checks', v_checks, 'totals', v_totals);
end $$;

revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
