-- Phase 3 functions, part A: helpers, schedules, charges, payments, allocation, reversal.
-- Roles: staff = record payments / allocate / receipts; manager = schedules, charges, reversals, expenses, audit;
--        admin = adjustments. Every balance-sensitive step runs inside one transaction with row locks.

create or replace function app.audit(p_org uuid, p_action text, p_type text, p_id uuid, p_before jsonb, p_after jsonb, p_reason text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.finance_audit (org_id, actor_id, action, entity_type, entity_id, reason, before_state, after_state)
  values (p_org, auth.uid(), p_action, p_type, p_id, p_reason, p_before, p_after) $$;

create or replace function app.due_date(p_first date, p_period public.rent_period, p_n int) returns date
language sql immutable set search_path = '' as $$
  select case p_period
    when 'weekly' then p_first + 7 * p_n
    when 'fortnightly' then p_first + 14 * p_n
    when 'monthly' then (p_first + make_interval(months => p_n))::date
    when 'quarterly' then (p_first + make_interval(months => 3 * p_n))::date
    when 'annually' then (p_first + make_interval(years => p_n))::date end $$;

create or replace function app.require_reason(p text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or char_length(btrim(p)) < 3 then raise exception 'a reason of at least 3 characters is required' using errcode = 'PT422'; end if;
  return btrim(p);
end $$;

create or replace function app.tenancy_today(p_tenancy uuid) returns date
language sql stable security definer set search_path = '' as $$
  select app.property_today(u.property_id) from public.tenancies t join public.units u on u.id = t.unit_id where t.id = p_tenancy $$;

create or replace function app.payment_json(p_org uuid, p_payment uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(ps) || jsonb_build_object(
    'allocations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'charge_id', a.charge_id, 'amount_minor', a.amount_minor,
        'created_at', a.created_at, 'reversed_at', a.reversed_at, 'reverse_reason', a.reverse_reason,
        'charge_description', c.description, 'charge_due_date', c.due_date) order by a.created_at, a.id)
      from public.payment_allocations a join public.charges c on c.id = a.charge_id where a.payment_id = ps.id), '[]'::jsonb),
    'receipt_id', (select r.id from public.receipts r where r.payment_id = ps.id))
  from app.payment_state ps where ps.id = p_payment and ps.org_id = p_org $$;

create or replace function app.charge_json(p_org uuid, p_charge uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(cs) from app.charge_state cs where cs.id = p_charge and cs.org_id = p_org $$;

-- ----------------------------------------------------------------- schedules
create or replace function public.create_rent_schedule(p_org uuid, p_tenancy uuid, p_amount_minor bigint,
  p_period public.rent_period, p_first_due_date date, p_end_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenancies; r public.rent_schedules; v_last date;
begin
  perform app.require_role(p_org, 'manager');
  t := app.load_tenancy(p_org, p_tenancy, true);
  if t.status not in ('draft', 'active') then raise exception 'a % tenancy cannot take a rent schedule', t.status using errcode = 'PT409'; end if;
  if p_first_due_date < t.start_date then raise exception 'first due date is before the tenancy starts' using errcode = 'PT422'; end if;
  if exists (select 1 from public.rent_schedules where tenancy_id = p_tenancy and status = 'active') then
    raise exception 'stop the current rent schedule before creating a new one' using errcode = 'PT409';
  end if;
  -- A new schedule may not re-bill periods an earlier schedule already charged.
  select max(coalesce(period_end, due_date)) into v_last from public.charges where tenancy_id = p_tenancy and schedule_id is not null;
  if v_last is not null and p_first_due_date <= v_last then
    raise exception 'first due date must be after % (already charged by the previous schedule)', v_last using errcode = 'PT409';
  end if;
  insert into public.rent_schedules (org_id, tenancy_id, currency, amount_minor, period, first_due_date, end_date, created_by)
  values (p_org, p_tenancy, t.currency, p_amount_minor, p_period, p_first_due_date, p_end_date, auth.uid()) returning * into r;
  perform app.audit(p_org, 'schedule.created', 'rent_schedule', r.id, null, to_jsonb(r));
  return to_jsonb(r);
end $$;

create or replace function public.stop_rent_schedule(p_org uuid, p_schedule uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.rent_schedules; v_old jsonb;
begin
  perform app.require_role(p_org, 'manager');
  select * into r from public.rent_schedules where id = p_schedule and org_id = p_org for update;
  if r.id is null then raise exception 'schedule not found' using errcode = 'PT404'; end if;
  if r.status = 'stopped' then return to_jsonb(r); end if;      -- idempotent
  v_old := to_jsonb(r);
  update public.rent_schedules set status = 'stopped', stopped_at = now(), stop_reason = app.require_reason(p_reason)
   where id = p_schedule returning * into r;
  perform app.audit(p_org, 'schedule.stopped', 'rent_schedule', r.id, v_old, to_jsonb(r), r.stop_reason);
  return to_jsonb(r);
end $$;

-- Idempotent: charges are unique per (schedule, due date), so running this any number of times, concurrently or
-- not, creates each charge exactly once. Due dates are computed from the schedule anchor (no month-end drift).
create or replace function public.generate_charges(p_org uuid, p_tenancy uuid default null, p_through date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; v_limit date; v_n int; v_due date; v_next date; v_rows int; v_created int := 0; v_schedules int := 0;
begin
  perform app.require_role(p_org, 'manager');
  if p_tenancy is not null then perform app.load_tenancy(p_org, p_tenancy); end if;
  for s in
    select rs.*, t.end_date as tenancy_end, app.property_today(u.property_id) as today
      from public.rent_schedules rs join public.tenancies t on t.id = rs.tenancy_id join public.units u on u.id = t.unit_id
     where rs.org_id = p_org and rs.status = 'active' and t.status = 'active' and (p_tenancy is null or rs.tenancy_id = p_tenancy)
     order by rs.id
  loop
    v_schedules := v_schedules + 1;
    v_limit := least(coalesce(p_through, s.today), s.today + 366, coalesce(s.end_date, 'infinity'::date), coalesce(s.tenancy_end, 'infinity'::date));
    v_n := 0;
    loop
      v_due := app.due_date(s.first_due_date, s.period, v_n);
      exit when v_due > v_limit or v_n > 1200;
      v_next := app.due_date(s.first_due_date, s.period, v_n + 1);
      insert into public.charges (org_id, tenancy_id, currency, schedule_id, kind, description, period_start, period_end, due_date, amount_minor, created_by)
      values (p_org, s.tenancy_id, s.currency, s.id, 'rent', 'Rent ' || v_due || ' to ' || (v_next - 1), v_due, v_next - 1, v_due, s.amount_minor, auth.uid())
      on conflict (schedule_id, due_date) where schedule_id is not null do nothing;
      get diagnostics v_rows = row_count;
      v_created := v_created + v_rows;
      v_n := v_n + 1;
    end loop;
  end loop;
  if v_created > 0 then
    perform app.audit(p_org, 'charges.generated', 'tenancy', p_tenancy, null, jsonb_build_object('created', v_created, 'through', p_through));
  end if;
  return jsonb_build_object('created', v_created, 'schedules', v_schedules);
end $$;

-- ------------------------------------------------------------------ charges
create or replace function public.create_charge(p_org uuid, p_tenancy uuid, p_kind public.charge_kind, p_description text,
  p_due_date date, p_amount_minor bigint, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenancies; r public.charges; v_id uuid;
begin
  perform app.require_role(p_org, 'manager');
  t := app.load_tenancy(p_org, p_tenancy);
  if t.status = 'cancelled' then raise exception 'tenancy is cancelled' using errcode = 'PT409'; end if;
  insert into public.charges (org_id, tenancy_id, currency, kind, description, due_date, amount_minor, idempotency_key, created_by)
  values (p_org, p_tenancy, t.currency, coalesce(p_kind, 'other'), btrim(p_description), p_due_date, p_amount_minor, p_idempotency_key, auth.uid())
  on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing returning id into v_id;
  if v_id is null then            -- replay of an earlier request
    select * into r from public.charges where org_id = p_org and idempotency_key = p_idempotency_key;
    if r.tenancy_id <> p_tenancy or r.amount_minor <> p_amount_minor or r.due_date <> p_due_date then
      raise exception 'idempotency key was already used for a different charge' using errcode = 'PT409';
    end if;
    return app.charge_json(p_org, r.id) || jsonb_build_object('replayed', true);
  end if;
  perform app.audit(p_org, 'charge.created', 'charge', v_id, null, app.charge_json(p_org, v_id));
  return app.charge_json(p_org, v_id) || jsonb_build_object('replayed', false);
end $$;

create or replace function public.void_charge(p_org uuid, p_charge uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.charges; v_before jsonb;
begin
  perform app.require_role(p_org, 'manager');
  select * into r from public.charges where id = p_charge and org_id = p_org for update;
  if r.id is null then raise exception 'charge not found' using errcode = 'PT404'; end if;
  if r.voided_at is not null then return app.charge_json(p_org, p_charge); end if;   -- idempotent
  v_before := app.charge_json(p_org, p_charge);
  update public.charges set voided_at = now(), voided_by = auth.uid(), void_reason = app.require_reason(p_reason) where id = p_charge;
  perform app.audit(p_org, 'charge.voided', 'charge', p_charge, v_before, app.charge_json(p_org, p_charge), btrim(p_reason));
  return app.charge_json(p_org, p_charge);
end $$;

create or replace function public.adjust_charge(p_org uuid, p_charge uuid, p_amount_minor bigint, p_reason text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.charges; v_before jsonb; v_adj uuid; v_ex public.charge_adjustments;
begin
  perform app.require_role(p_org, 'admin');
  select * into r from public.charges where id = p_charge and org_id = p_org for update;
  if r.id is null then raise exception 'charge not found' using errcode = 'PT404'; end if;
  select * into v_ex from public.charge_adjustments where org_id = p_org and idempotency_key = p_idempotency_key;
  if v_ex.id is not null then
    if v_ex.charge_id <> p_charge or v_ex.amount_minor <> p_amount_minor then
      raise exception 'idempotency key was already used for a different adjustment' using errcode = 'PT409';
    end if;
    return app.charge_json(p_org, p_charge) || jsonb_build_object('replayed', true);
  end if;
  v_before := app.charge_json(p_org, p_charge);
  insert into public.charge_adjustments (org_id, charge_id, tenancy_id, currency, amount_minor, reason, idempotency_key, created_by)
  values (p_org, p_charge, r.tenancy_id, r.currency, p_amount_minor, app.require_reason(p_reason), p_idempotency_key, auth.uid()) returning id into v_adj;
  perform app.audit(p_org, 'charge.adjusted', 'charge', p_charge, v_before, app.charge_json(p_org, p_charge), btrim(p_reason));
  return app.charge_json(p_org, p_charge) || jsonb_build_object('replayed', false, 'adjustment_id', v_adj);
end $$;

-- ----------------------------------------------------------------- payments
-- Applies oldest-due-first. Locks the tenancy's charges in (due_date, created_at, id) order, the same order every
-- other allocation path uses, so concurrent operations cannot deadlock.
create or replace function app.allocate_fifo(p_org uuid, p_payment uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare p public.payments; v_remaining bigint; c record; v_out bigint; v_take bigint; v_total bigint := 0;
begin
  select * into p from public.payments where id = p_payment and org_id = p_org for update;
  if p.reversed_at is not null then return 0; end if;
  select unallocated_minor into v_remaining from app.payment_state where id = p_payment;
  for c in select id from public.charges where tenancy_id = p.tenancy_id and currency = p.currency and voided_at is null
            order by due_date, created_at, id for update loop
    exit when v_remaining <= 0;
    select outstanding_minor into v_out from app.charge_state where id = c.id;
    continue when v_out <= 0;
    v_take := least(v_out, v_remaining);
    insert into public.payment_allocations (org_id, payment_id, charge_id, tenancy_id, currency, amount_minor, created_by)
    values (p_org, p_payment, c.id, p.tenancy_id, p.currency, v_take, auth.uid());
    perform app.audit(p_org, 'allocation.created', 'payment', p_payment, null,
      jsonb_build_object('charge_id', c.id, 'amount_minor', v_take, 'mode', 'auto'));
    v_remaining := v_remaining - v_take; v_total := v_total + v_take;
  end loop;
  return v_total;
end $$;

create or replace function public.record_payment(p_org uuid, p_tenancy uuid, p_amount_minor bigint, p_received_on date,
  p_method public.payment_method, p_reference text, p_note text, p_tenant uuid, p_currency text, p_idempotency_key text,
  p_auto_allocate boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tenancies; v_id uuid; r public.payments; v_cur text;
begin
  perform app.require_role(p_org, 'staff');
  t := app.load_tenancy(p_org, p_tenancy);
  if t.status = 'cancelled' then raise exception 'tenancy is cancelled' using errcode = 'PT409'; end if;
  v_cur := upper(coalesce(p_currency, t.currency));
  if v_cur <> t.currency then
    raise exception 'payment currency % differs from the tenancy currency %; foreign-exchange is not supported', v_cur, t.currency using errcode = 'PT422';
  end if;
  if p_received_on > app.tenancy_today(p_tenancy) then raise exception 'the payment date cannot be in the future' using errcode = 'PT422'; end if;
  if p_tenant is not null and not exists (select 1 from public.tenancy_tenants where tenancy_id = p_tenancy and tenant_id = p_tenant) then
    raise exception 'payer is not a tenant on this tenancy' using errcode = 'PT422';
  end if;
  -- Serialise requests that share an idempotency key, then look for the earlier result BEFORE inserting. Relying on
  -- ON CONFLICT alone is racy here: the reference index can raise first, turning a harmless retry into a false 409.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':payment:' || p_idempotency_key, 0));
  select * into r from public.payments where org_id = p_org and idempotency_key = p_idempotency_key;
  if r.id is not null then
    if r.tenancy_id <> p_tenancy or r.amount_minor <> p_amount_minor or r.received_on <> p_received_on or lower(r.reference) <> lower(btrim(p_reference)) then
      raise exception 'idempotency key was already used for a different payment' using errcode = 'PT409';
    end if;
    return app.payment_json(p_org, r.id) || jsonb_build_object('replayed', true);
  end if;
  begin
    insert into public.payments (org_id, tenancy_id, currency, tenant_id, amount_minor, received_on, method, reference, note, idempotency_key, created_by)
    values (p_org, p_tenancy, t.currency, p_tenant, p_amount_minor, p_received_on, p_method, btrim(p_reference), nullif(btrim(p_note), ''), p_idempotency_key, auth.uid())
    on conflict (org_id, idempotency_key) do nothing returning id into v_id;
  exception when unique_violation then
    raise exception 'a payment with this reference already exists on this tenancy' using errcode = 'PT409';
  end;
  if v_id is null then            -- replay: same key, same request => same payment, nothing new written
    select * into r from public.payments where org_id = p_org and idempotency_key = p_idempotency_key;
    if r.tenancy_id <> p_tenancy or r.amount_minor <> p_amount_minor or r.received_on <> p_received_on or lower(r.reference) <> lower(btrim(p_reference)) then
      raise exception 'idempotency key was already used for a different payment' using errcode = 'PT409';
    end if;
    return app.payment_json(p_org, r.id) || jsonb_build_object('replayed', true);
  end if;
  perform app.audit(p_org, 'payment.recorded', 'payment', v_id, null,
    jsonb_build_object('amount_minor', p_amount_minor, 'currency', t.currency, 'reference', btrim(p_reference), 'received_on', p_received_on, 'verification', 'manual_unverified'));
  if coalesce(p_auto_allocate, false) then perform app.allocate_fifo(p_org, v_id); end if;
  return app.payment_json(p_org, v_id) || jsonb_build_object('replayed', false);
end $$;

create or replace function public.auto_allocate_payment(p_org uuid, p_payment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  if not exists (select 1 from public.payments where id = p_payment and org_id = p_org) then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if (select reversed_at from public.payments where id = p_payment) is not null then
    raise exception 'payment is reversed' using errcode = 'PT409';
  end if;
  perform app.allocate_fifo(p_org, p_payment);
  return app.payment_json(p_org, p_payment);
end $$;

-- p_allocations: [{"charge_id": "...", "amount_minor": 12345}, ...]
create or replace function public.allocate_payment(p_org uuid, p_payment uuid, p_allocations jsonb, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.payments; x record; v_n int; v_found int; c public.charges;
begin
  perform app.require_role(p_org, 'staff');
  select * into p from public.payments where id = p_payment and org_id = p_org for update;    -- serialises operations on this payment
  if p.id is null then raise exception 'payment not found' using errcode = 'PT404'; end if;
  if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) not between 1 and 50 then
    raise exception 'provide between 1 and 50 allocations' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.payment_allocations where payment_id = p_payment and idempotency_key = p_idempotency_key) then
    return app.payment_json(p_org, p_payment) || jsonb_build_object('replayed', true);
  end if;
  if p.reversed_at is not null then raise exception 'payment is reversed' using errcode = 'PT409'; end if;

  select count(*), count(distinct charge_id) into v_n, v_found from jsonb_to_recordset(p_allocations) as a(charge_id uuid, amount_minor bigint);
  if v_n <> v_found then raise exception 'each charge may appear only once per request' using errcode = 'PT422'; end if;
  if exists (select 1 from jsonb_to_recordset(p_allocations) as a(charge_id uuid, amount_minor bigint) where a.amount_minor is null or a.amount_minor <= 0 or a.charge_id is null) then
    raise exception 'allocation amounts must be positive' using errcode = 'PT422';
  end if;

  for x in select a.charge_id, a.amount_minor from jsonb_to_recordset(p_allocations) as a(charge_id uuid, amount_minor bigint)
             left join public.charges ch on ch.id = a.charge_id order by ch.due_date, ch.created_at, a.charge_id
  loop
    select * into c from public.charges where id = x.charge_id and org_id = p_org;
    if c.id is null then raise exception 'charge not found' using errcode = 'PT404'; end if;
    if c.tenancy_id <> p.tenancy_id then raise exception 'charge belongs to a different tenancy' using errcode = 'PT422'; end if;
    if c.currency <> p.currency then
      raise exception 'currency mismatch: payment is % and charge is %; no conversion is performed', p.currency, c.currency using errcode = 'PT422';
    end if;
    insert into public.payment_allocations (org_id, payment_id, charge_id, tenancy_id, currency, amount_minor, idempotency_key, created_by)
    values (p_org, p_payment, x.charge_id, p.tenancy_id, p.currency, x.amount_minor, p_idempotency_key, auth.uid());
    perform app.audit(p_org, 'allocation.created', 'payment', p_payment, null,
      jsonb_build_object('charge_id', x.charge_id, 'amount_minor', x.amount_minor, 'mode', 'manual'));
  end loop;
  return app.payment_json(p_org, p_payment) || jsonb_build_object('replayed', false);
end $$;

create or replace function public.reverse_allocation(p_org uuid, p_allocation uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.payment_allocations;
begin
  perform app.require_role(p_org, 'manager');
  select * into a from public.payment_allocations where id = p_allocation and org_id = p_org for update;
  if a.id is null then raise exception 'allocation not found' using errcode = 'PT404'; end if;
  if a.reversed_at is null then
    update public.payment_allocations set reversed_at = now(), reversed_by = auth.uid(), reverse_reason = app.require_reason(p_reason) where id = p_allocation;
    perform app.audit(p_org, 'allocation.reversed', 'payment', a.payment_id, jsonb_build_object('allocation_id', a.id, 'charge_id', a.charge_id, 'amount_minor', a.amount_minor), null, btrim(p_reason));
  end if;
  return app.payment_json(p_org, a.payment_id);
end $$;

-- Reversal keeps the payment on record, releases everything it was applied to, and voids its receipt.
create or replace function public.reverse_payment(p_org uuid, p_payment uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.payments; v_before jsonb; v_released int;
begin
  perform app.require_role(p_org, 'manager');
  select * into p from public.payments where id = p_payment and org_id = p_org for update;
  if p.id is null then raise exception 'payment not found' using errcode = 'PT404'; end if;
  if p.reversed_at is not null then return app.payment_json(p_org, p_payment) || jsonb_build_object('already_reversed', true); end if;
  perform app.require_reason(p_reason);
  v_before := app.payment_json(p_org, p_payment);
  update public.payment_allocations set reversed_at = now(), reversed_by = auth.uid(), reverse_reason = 'payment reversed: ' || btrim(p_reason)
   where payment_id = p_payment and reversed_at is null;
  get diagnostics v_released = row_count;
  update public.payments set reversed_at = now(), reversed_by = auth.uid(), reverse_reason = btrim(p_reason) where id = p_payment;
  update public.receipts set voided_at = now(), void_reason = 'payment reversed' where payment_id = p_payment and voided_at is null;
  perform app.audit(p_org, 'payment.reversed', 'payment', p_payment, v_before, app.payment_json(p_org, p_payment) || jsonb_build_object('allocations_released', v_released), btrim(p_reason));
  return app.payment_json(p_org, p_payment) || jsonb_build_object('already_reversed', false);
end $$;
