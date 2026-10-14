-- Phase 3: rent ledger. Money is bigint minor units + explicit ISO-4217 currency. No floats anywhere.
--
-- Model (all append-only; corrections are new rows or reversal markers, never edits/deletes):
--   rent_schedules  recurring rent definition per tenancy
--   charges         amounts owed (generated from a schedule, or manual)
--   adjustments     signed corrections to a charge (waivers, uplifts); admin-only
--   payments        money received (manual entry, never provider-verified)
--   payment_allocations  how a payment is applied to charges (same tenancy AND same currency, by FK)
--   receipts        numbered, immutable snapshots issued for a payment
--   expenses        costs recorded against a property
--   finance_audit   append-only history of every financial change
-- Balances are DERIVED from these rows (views in schema app); nothing stores a running total.

do $$ begin create type public.charge_kind as enum ('rent','deposit','fee','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_method as enum ('bank_transfer','cash','card','cheque','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.expense_category as enum
  ('maintenance','repairs','utilities','insurance','taxes','management_fees','legal','supplies','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.schedule_status as enum ('active','stopped');
exception when duplicate_object then null; end $$;

-- Targets for composite foreign keys that bind currency (and tenancy) across tables.
create unique index if not exists tenancies_org_id_currency_key on public.tenancies (org_id, id, currency);
create unique index if not exists properties_org_id_currency_key on public.properties (org_id, id, currency);
create unique index if not exists units_org_property_id_key on public.units (org_id, property_id, id);

-- ------------------------------------------------------------ rent schedules
create table if not exists public.rent_schedules (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  tenancy_id     uuid not null,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor   bigint not null check (amount_minor > 0 and amount_minor <= 1000000000000),
  period         public.rent_period not null,
  first_due_date date not null,          -- anchor: every due date is computed from this, so month-end never drifts
  end_date       date,
  status         public.schedule_status not null default 'active',
  stopped_at     timestamptz,
  stop_reason    text check (char_length(stop_reason) <= 500),
  created_by     uuid not null references auth.users (id),
  created_at     timestamptz not null default now(),
  foreign key (org_id, tenancy_id, currency) references public.tenancies (org_id, id, currency) on delete restrict,
  unique (org_id, id),
  check (end_date is null or end_date >= first_due_date),
  check ((status = 'stopped') = (stopped_at is not null))
);
create unique index if not exists rent_schedules_one_active_idx on public.rent_schedules (tenancy_id) where status = 'active';

-- ------------------------------------------------------------------ charges
create table if not exists public.charges (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  tenancy_id       uuid not null,
  currency         char(3) not null check (currency ~ '^[A-Z]{3}$'),
  schedule_id      uuid,
  kind             public.charge_kind not null default 'rent',
  description      text not null check (char_length(description) between 1 and 200),
  period_start     date,
  period_end       date,
  due_date         date not null,
  amount_minor     bigint not null check (amount_minor > 0 and amount_minor <= 1000000000000),
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) between 8 and 80),
  voided_at        timestamptz,
  voided_by        uuid references auth.users (id),
  void_reason      text check (char_length(void_reason) <= 500),
  created_by       uuid references auth.users (id),   -- null only for system-generated schedule charges
  created_at       timestamptz not null default now(),
  foreign key (org_id, tenancy_id, currency) references public.tenancies (org_id, id, currency) on delete restrict,
  foreign key (org_id, schedule_id) references public.rent_schedules (org_id, id) on delete restrict,
  unique (org_id, id, tenancy_id, currency),
  check (period_end is null or period_start is null or period_end >= period_start),
  check ((voided_at is null) = (void_reason is null))
);
-- Idempotent generation: one charge per schedule per due date, ever (a voided one is not silently recreated).
create unique index if not exists charges_schedule_due_idx on public.charges (schedule_id, due_date) where schedule_id is not null;
create unique index if not exists charges_idem_idx on public.charges (org_id, idempotency_key) where idempotency_key is not null;
create index if not exists charges_tenancy_idx on public.charges (tenancy_id, due_date);

-- ----------------------------------------------------------------- payments
create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  tenancy_id       uuid not null,
  currency         char(3) not null check (currency ~ '^[A-Z]{3}$'),
  tenant_id        uuid,                        -- who paid (optional; must be a tenant of this org)
  amount_minor     bigint not null check (amount_minor > 0 and amount_minor <= 1000000000000),
  received_on      date not null,
  method           public.payment_method not null,
  reference        text not null check (char_length(btrim(reference)) between 1 and 100),
  note             text check (char_length(note) <= 1000),
  -- Manual entry. There is no bank or provider integration, so nothing here is ever "verified".
  verification     text not null default 'manual_unverified' check (verification = 'manual_unverified'),
  idempotency_key  text not null check (char_length(idempotency_key) between 8 and 80),
  reversed_at      timestamptz,
  reversed_by      uuid references auth.users (id),
  reverse_reason   text check (char_length(reverse_reason) <= 500),
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  foreign key (org_id, tenancy_id, currency) references public.tenancies (org_id, id, currency) on delete restrict,
  foreign key (org_id, tenant_id) references public.tenants (org_id, id) on delete restrict,
  unique (org_id, id),
  unique (org_id, id, tenancy_id, currency),
  unique (org_id, idempotency_key),
  check ((reversed_at is null) = (reverse_reason is null))
);
-- The same bank reference cannot be booked twice against a tenancy (until the first is reversed).
create unique index if not exists payments_reference_idx on public.payments (org_id, tenancy_id, lower(btrim(reference))) where reversed_at is null;
create index if not exists payments_tenancy_idx on public.payments (tenancy_id, received_on);

-- -------------------------------------------------------------- allocations
-- currency and tenancy are part of BOTH foreign keys: an allocation can only join a payment and a charge
-- of the same tenancy and the same currency. There is no implicit conversion and no way to bypass it.
create table if not exists public.payment_allocations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  payment_id       uuid not null,
  charge_id        uuid not null,
  tenancy_id       uuid not null,
  currency         char(3) not null,
  amount_minor     bigint not null check (amount_minor > 0),
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) between 8 and 80),
  reversed_at      timestamptz,
  reversed_by      uuid references auth.users (id),
  reverse_reason   text check (char_length(reverse_reason) <= 500),
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  foreign key (org_id, payment_id, tenancy_id, currency) references public.payments (org_id, id, tenancy_id, currency) on delete restrict,
  foreign key (org_id, charge_id, tenancy_id, currency)  references public.charges  (org_id, id, tenancy_id, currency) on delete restrict,
  unique (org_id, id),
  check ((reversed_at is null) = (reverse_reason is null))
);
create unique index if not exists allocations_idem_idx on public.payment_allocations (payment_id, charge_id, idempotency_key) where idempotency_key is not null;
create index if not exists allocations_payment_idx on public.payment_allocations (payment_id) where reversed_at is null;
create index if not exists allocations_charge_idx on public.payment_allocations (charge_id) where reversed_at is null;

-- -------------------------------------------------------------- adjustments
create table if not exists public.charge_adjustments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  charge_id        uuid not null,
  tenancy_id       uuid not null,
  currency         char(3) not null,
  amount_minor     bigint not null check (amount_minor <> 0 and abs(amount_minor) <= 1000000000000),  -- signed
  reason           text not null check (char_length(btrim(reason)) between 3 and 500),
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) between 8 and 80),
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  foreign key (org_id, charge_id, tenancy_id, currency) references public.charges (org_id, id, tenancy_id, currency) on delete restrict
);
create unique index if not exists adjustments_idem_idx on public.charge_adjustments (org_id, idempotency_key) where idempotency_key is not null;
create index if not exists adjustments_charge_idx on public.charge_adjustments (charge_id);

-- ----------------------------------------------------------------- expenses
create table if not exists public.expenses (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  property_id      uuid not null,
  unit_id          uuid,
  currency         char(3) not null,
  category         public.expense_category not null,
  description      text not null check (char_length(btrim(description)) between 1 and 200),
  vendor           text check (char_length(vendor) <= 160),
  reference        text check (char_length(reference) <= 100),
  amount_minor     bigint not null check (amount_minor > 0 and amount_minor <= 1000000000000),
  incurred_on      date not null,
  idempotency_key  text not null check (char_length(idempotency_key) between 8 and 80),
  voided_at        timestamptz,
  voided_by        uuid references auth.users (id),
  void_reason      text check (char_length(void_reason) <= 500),
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  foreign key (org_id, property_id, currency) references public.properties (org_id, id, currency) on delete restrict,
  foreign key (org_id, property_id, unit_id) references public.units (org_id, property_id, id) on delete restrict,
  unique (org_id, idempotency_key),
  check ((voided_at is null) = (void_reason is null))
);
create index if not exists expenses_property_idx on public.expenses (property_id, incurred_on);

-- ----------------------------------------------------------------- receipts
create table if not exists public.org_counters (
  org_id uuid not null references public.organizations (id) on delete restrict,
  name   text not null,
  value  bigint not null default 0,
  primary key (org_id, name)
);
create table if not exists public.receipts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  payment_id  uuid not null,
  seq         bigint not null,
  number      text not null,
  snapshot    jsonb not null,                 -- frozen copy of what the receipt said when issued
  issued_by   uuid not null references auth.users (id),
  issued_at   timestamptz not null default now(),
  voided_at   timestamptz,
  void_reason text check (char_length(void_reason) <= 500),
  foreign key (org_id, payment_id) references public.payments (org_id, id) on delete restrict,
  unique (org_id, number),
  unique (payment_id),
  check ((voided_at is null) = (void_reason is null))
);

-- -------------------------------------------------------------------- audit
create table if not exists public.finance_audit (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references public.organizations (id) on delete restrict,
  actor_id     uuid references auth.users (id),
  action       text not null,
  entity_type  text not null,
  entity_id    uuid,
  reason       text,
  before_state jsonb,
  after_state  jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists finance_audit_entity_idx on public.finance_audit (org_id, entity_type, entity_id);
create index if not exists finance_audit_time_idx on public.finance_audit (org_id, created_at desc);

-- ----------------------------------------------------------------- guards
-- Append-only: rows can't be deleted; only the listed marker columns may change, and once a marker is set it is permanent.
create or replace function app.finance_guard() returns trigger
language plpgsql set search_path = '' as $$
declare o jsonb; n jsonb; k text;
begin
  if tg_op = 'DELETE' then
    raise exception '% rows are append-only and cannot be deleted', tg_table_name using errcode = 'PT409';
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(o) loop
    if n -> k is not distinct from o -> k then continue; end if;
    if k = any (tg_argv) then
      if k like '%\_at' and o -> k <> 'null'::jsonb then
        raise exception '% on % is permanent once set', k, tg_table_name using errcode = 'PT409';
      end if;
    else
      raise exception '% on % is immutable', k, tg_table_name using errcode = 'PT409';
    end if;
  end loop;
  return new;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('rent_schedules',    array['status','stopped_at','stop_reason']),
    ('charges',           array['voided_at','voided_by','void_reason']),
    ('payments',          array['reversed_at','reversed_by','reverse_reason']),
    ('payment_allocations', array['reversed_at','reversed_by','reverse_reason']),
    ('charge_adjustments', array[]::text[]),
    ('expenses',          array['voided_at','voided_by','void_reason']),
    ('receipts',          array['voided_at','void_reason']),
    ('finance_audit',     array[]::text[])) v(t, cols)
  loop
    execute format('drop trigger if exists %I_guard on public.%I', r.t, r.t);
    execute format('create trigger %I_guard before update or delete on public.%I for each row execute function app.finance_guard(%s)',
      r.t, r.t, coalesce((select string_agg(quote_literal(c), ',') from unnest(r.cols) c), ''));
  end loop;
end $$;

-- Over-allocation backstop. Takes row locks in a fixed order (payment, then charge) and re-checks the limits, so
-- concurrent allocations to one payment or charge serialize and the second sees the first's effect. It fires for
-- every INSERT, so it holds even if some future code path inserts allocations directly.
create or replace function app.enforce_allocation_limits() returns trigger
language plpgsql set search_path = '' as $$
declare p public.payments; c public.charges; v_paid bigint; v_charged bigint; v_adj bigint;
begin
  select * into p from public.payments where id = new.payment_id for update;
  if p.reversed_at is not null then raise exception 'payment is reversed' using errcode = 'PT409'; end if;
  select * into c from public.charges where id = new.charge_id for update;
  if c.voided_at is not null then raise exception 'charge is void' using errcode = 'PT409'; end if;

  select coalesce(sum(amount_minor), 0) into v_paid from public.payment_allocations
   where payment_id = new.payment_id and reversed_at is null;
  if v_paid + new.amount_minor > p.amount_minor then
    raise exception 'allocation exceeds the unallocated amount of the payment' using errcode = 'PT409';
  end if;

  select coalesce(sum(amount_minor), 0) into v_charged from public.payment_allocations
   where charge_id = new.charge_id and reversed_at is null;
  select coalesce(sum(amount_minor), 0) into v_adj from public.charge_adjustments where charge_id = new.charge_id;
  if v_charged + new.amount_minor > c.amount_minor + v_adj then
    raise exception 'allocation exceeds the outstanding amount of the charge' using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists payment_allocations_limits on public.payment_allocations;
create trigger payment_allocations_limits before insert on public.payment_allocations
  for each row execute function app.enforce_allocation_limits();

-- A charge can never be adjusted below what has already been applied to it, or below zero.
create or replace function app.enforce_adjustment_limits() returns trigger
language plpgsql set search_path = '' as $$
declare c public.charges; v_alloc bigint; v_adj bigint;
begin
  select * into c from public.charges where id = new.charge_id for update;
  if c.voided_at is not null then raise exception 'charge is void' using errcode = 'PT409'; end if;
  select coalesce(sum(amount_minor), 0) into v_alloc from public.payment_allocations where charge_id = new.charge_id and reversed_at is null;
  select coalesce(sum(amount_minor), 0) into v_adj from public.charge_adjustments where charge_id = new.charge_id;
  if c.amount_minor + v_adj + new.amount_minor < v_alloc then
    raise exception 'adjustment would reduce the charge below the amount already paid; reverse the allocation first' using errcode = 'PT409';
  end if;
  if c.amount_minor + v_adj + new.amount_minor < 0 then
    raise exception 'adjustment would make the charge negative' using errcode = 'PT422';
  end if;
  return new;
end $$;
drop trigger if exists charge_adjustments_limits on public.charge_adjustments;
create trigger charge_adjustments_limits before insert on public.charge_adjustments
  for each row execute function app.enforce_adjustment_limits();

-- A charge can only be voided while nothing is applied to it.
create or replace function app.enforce_void_charge() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.voided_at is not null and old.voided_at is null and exists (
       select 1 from public.payment_allocations where charge_id = new.id and reversed_at is null) then
    raise exception 'reverse the allocations on this charge before voiding it' using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists charges_void_check on public.charges;
create trigger charges_void_check before update on public.charges for each row execute function app.enforce_void_charge();

-- ------------------------------------------------- derived balances (views)
-- security_invoker is not needed: these live in schema `app` (not exposed) and are read only by the
-- SECURITY DEFINER functions, which do their own role checks.
create or replace view app.charge_state as
select c.id, c.org_id, c.tenancy_id, c.currency, c.schedule_id, c.kind, c.description, c.period_start, c.period_end,
       c.due_date, c.amount_minor, c.voided_at, c.void_reason, c.created_at,
       u.property_id, u.id as unit_id,
       coalesce(adj.total, 0)::bigint as adjusted_minor,
       (c.amount_minor + coalesce(adj.total, 0))::bigint as effective_minor,
       coalesce(al.total, 0)::bigint as allocated_minor,
       case when c.voided_at is not null then 0
            else (c.amount_minor + coalesce(adj.total, 0) - coalesce(al.total, 0)) end::bigint as outstanding_minor,
       case when c.voided_at is not null then 'void'
            when c.amount_minor + coalesce(adj.total, 0) = 0 then 'waived'
            when c.amount_minor + coalesce(adj.total, 0) - coalesce(al.total, 0) = 0 then 'paid'
            when coalesce(al.total, 0) > 0 then 'partial'
            else 'unpaid' end as status,
       (c.voided_at is null and c.amount_minor + coalesce(adj.total, 0) - coalesce(al.total, 0) > 0
          and c.due_date < (now() at time zone pr.timezone)::date) as is_overdue,
       (now() at time zone pr.timezone)::date as today
from public.charges c
  join public.tenancies t on t.id = c.tenancy_id
  join public.units u on u.id = t.unit_id
  join public.properties pr on pr.id = u.property_id
  left join lateral (select sum(a.amount_minor) as total from public.charge_adjustments a where a.charge_id = c.id) adj on true
  left join lateral (select sum(a.amount_minor) as total from public.payment_allocations a
                      where a.charge_id = c.id and a.reversed_at is null) al on true;

create or replace view app.payment_state as
select p.id, p.org_id, p.tenancy_id, p.currency, p.tenant_id, p.amount_minor, p.received_on, p.method, p.reference, p.note,
       p.verification, p.reversed_at, p.reverse_reason, p.created_at, p.created_by, u.property_id, u.id as unit_id,
       coalesce(al.total, 0)::bigint as allocated_minor,
       case when p.reversed_at is not null then 0 else (p.amount_minor - coalesce(al.total, 0)) end::bigint as unallocated_minor,
       case when p.reversed_at is not null then 'reversed'
            when coalesce(al.total, 0) = 0 then 'unallocated'
            when coalesce(al.total, 0) < p.amount_minor then 'partial'
            else 'allocated' end as status
from public.payments p
  join public.tenancies t on t.id = p.tenancy_id
  join public.units u on u.id = t.unit_id
  left join lateral (select sum(a.amount_minor) as total from public.payment_allocations a
                      where a.payment_id = p.id and a.reversed_at is null) al on true;
