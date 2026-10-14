-- Finance tables are read-only to API roles; every write goes through the audited functions.
-- Read: staff+ (viewers see tenancy terms but not payment history). Audit trail: manager+.

revoke all on public.rent_schedules, public.charges, public.payments, public.payment_allocations,
  public.charge_adjustments, public.expenses, public.receipts, public.finance_audit, public.org_counters
  from anon, authenticated;
grant select on public.rent_schedules, public.charges, public.payments, public.payment_allocations,
  public.charge_adjustments, public.expenses, public.receipts, public.finance_audit to authenticated;

do $$
declare t text;
begin
  foreach t in array array['rent_schedules','charges','payments','payment_allocations','charge_adjustments','expenses','receipts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (app.has_role(org_id, ''staff''))', t, t);
  end loop;
end $$;

alter table public.finance_audit enable row level security;
drop policy if exists finance_audit_select on public.finance_audit;
create policy finance_audit_select on public.finance_audit for select to authenticated using (app.has_role(org_id, 'manager'));

-- org_counters: RLS on with no policy => unreachable from the API; only SECURITY DEFINER code touches it.
alter table public.org_counters enable row level security;
