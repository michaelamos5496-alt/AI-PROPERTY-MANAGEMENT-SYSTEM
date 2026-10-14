-- Phase 8: reconciliation also proves the charge_balances cache equals the ledger.
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

  -- the cache table must equal what the ledger rows add up to
  select count(*) into v_n from public.charges c left join public.charge_balances b on b.charge_id = c.id where c.org_id = p_org
     and (b.charge_id is null
          or b.adjusted_minor <> (select coalesce(sum(j.amount_minor), 0) from public.charge_adjustments j where j.charge_id = c.id)
          or b.allocated_minor <> (select coalesce(sum(a.amount_minor), 0) from public.payment_allocations a where a.charge_id = c.id and a.reversed_at is null));
  v_checks := v_checks || jsonb_build_object('name', 'Cached charge balances equal the sums of the ledger rows', 'ok', v_n = 0, 'violations', v_n);

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

grant execute on function public.reconcile_finance(uuid) to authenticated;
