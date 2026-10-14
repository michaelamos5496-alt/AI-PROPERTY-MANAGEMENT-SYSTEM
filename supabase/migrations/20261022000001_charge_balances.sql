-- Phase 8 (found by the load test): every list of charges recomputed each charge's adjustments and allocations on the fly, so an
-- organization-wide list over ~33,000 charges cost ~450 ms per call and ~4 s at 20 concurrent users on a laptop-class server.
--
-- The ledger tables stay the single source of truth and stay append-only. This table is a CACHE of two sums per charge, maintained by
-- triggers in the same transaction as the row that changes them, and `reconcile_finance` now proves it equals the recomputation.
-- app.charge_state keeps exactly the same columns, so no function that reads balances changes.

create table if not exists public.charge_balances (
  charge_id        uuid primary key references public.charges (id) on delete restrict,
  org_id           uuid not null,
  adjusted_minor   bigint not null default 0,      -- sum of charge_adjustments
  allocated_minor  bigint not null default 0       -- sum of ACTIVE payment_allocations
);
create index if not exists charge_balances_org_idx on public.charge_balances (org_id);
revoke all on public.charge_balances from anon, authenticated;
alter table public.charge_balances enable row level security;

insert into public.charge_balances (charge_id, org_id, adjusted_minor, allocated_minor)
select c.id, c.org_id,
       coalesce((select sum(j.amount_minor) from public.charge_adjustments j where j.charge_id = c.id), 0),
       coalesce((select sum(a.amount_minor) from public.payment_allocations a where a.charge_id = c.id and a.reversed_at is null), 0)
  from public.charges c
on conflict (charge_id) do nothing;

create or replace function app.trg_cb_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin insert into public.charge_balances (charge_id, org_id) values (new.id, new.org_id) on conflict (charge_id) do nothing; return new; end $$;
drop trigger if exists charges_balance_row on public.charges;
create trigger charges_balance_row after insert on public.charges for each row execute function app.trg_cb_charge();

create or replace function app.trg_cb_adjustment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin update public.charge_balances set adjusted_minor = adjusted_minor + new.amount_minor where charge_id = new.charge_id; return new; end $$;
drop trigger if exists adjustments_balance on public.charge_adjustments;
create trigger adjustments_balance after insert on public.charge_adjustments for each row execute function app.trg_cb_adjustment();

create or replace function app.trg_cb_allocation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.reversed_at is null then update public.charge_balances set allocated_minor = allocated_minor + new.amount_minor where charge_id = new.charge_id; end if;
  elsif old.reversed_at is null and new.reversed_at is not null then
    update public.charge_balances set allocated_minor = allocated_minor - old.amount_minor where charge_id = old.charge_id;
  end if;
  return new;
end $$;
drop trigger if exists allocations_balance on public.payment_allocations;
create trigger allocations_balance after insert or update of reversed_at on public.payment_allocations for each row execute function app.trg_cb_allocation();

create or replace view app.charge_state as
select c.id, c.org_id, c.tenancy_id, c.currency, c.schedule_id, c.kind, c.description, c.period_start, c.period_end,
       c.due_date, c.amount_minor, c.voided_at, c.void_reason, c.created_at,
       u.property_id, u.id as unit_id,
       b.adjusted_minor::bigint as adjusted_minor,
       (c.amount_minor + b.adjusted_minor)::bigint as effective_minor,
       b.allocated_minor::bigint as allocated_minor,
       case when c.voided_at is not null then 0
            else (c.amount_minor + b.adjusted_minor - b.allocated_minor) end::bigint as outstanding_minor,
       case when c.voided_at is not null then 'void'
            when c.amount_minor + b.adjusted_minor = 0 then 'waived'
            when c.amount_minor + b.adjusted_minor - b.allocated_minor = 0 then 'paid'
            when b.allocated_minor > 0 then 'partial'
            else 'unpaid' end as status,
       (c.voided_at is null and c.amount_minor + b.adjusted_minor - b.allocated_minor > 0
          and c.due_date < (now() at time zone pr.timezone)::date) as is_overdue,
       (now() at time zone pr.timezone)::date as today
from public.charges c
  join public.charge_balances b on b.charge_id = c.id
  join public.tenancies t on t.id = c.tenancy_id
  join public.units u on u.id = t.unit_id
  join public.properties pr on pr.id = u.property_id;
