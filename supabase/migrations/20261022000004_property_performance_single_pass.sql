-- Phase 8 (load test): the property report ran four correlated scans of every charge per property; it is now one grouped pass. Same output.
create or replace function public.property_performance(p_org uuid, p_from date, p_to date, p_property uuid default null, p_currency text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'staff');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'choose a valid period' using errcode = 'PT422'; end if;
  if p_to - p_from > 1830 then raise exception 'the period can be at most 5 years' using errcode = 'PT422'; end if;
  return coalesce((
    with c as (
      select property_id, currency, coalesce(sum(effective_minor) filter (where voided_at is null), 0)::bigint as billed_minor, coalesce(sum(allocated_minor) filter (where voided_at is null), 0)::bigint as collected_minor,
             coalesce(sum(outstanding_minor), 0)::bigint as outstanding_minor, coalesce(sum(outstanding_minor) filter (where is_overdue), 0)::bigint as overdue_minor
        from app.charge_state where org_id = p_org and due_date between p_from and p_to and (p_property is null or property_id = p_property) and (p_currency is null or currency = upper(p_currency)) group by property_id, currency),
    pay as (
      select property_id, currency, coalesce(sum(amount_minor) filter (where reversed_at is null), 0)::bigint as payments_received_minor
        from app.payment_state where org_id = p_org and received_on between p_from and p_to and (p_property is null or property_id = p_property) and (p_currency is null or currency = upper(p_currency)) group by property_id, currency),
    exp as (
      select property_id, currency, coalesce(sum(amount_minor) filter (where voided_at is null), 0)::bigint as expenses_minor
        from public.expenses where org_id = p_org and incurred_on between p_from and p_to and (p_property is null or property_id = p_property) and (p_currency is null or currency = upper(p_currency)) group by property_id, currency),
    keys as (select property_id, currency from c union select property_id, currency from pay union select property_id, currency from exp),
    rows_ as (
      select k.property_id, pr.name as property_name, k.currency, coalesce(c.billed_minor, 0) as billed_minor, coalesce(c.collected_minor, 0) as collected_minor,
             coalesce(c.outstanding_minor, 0) as outstanding_minor, coalesce(c.overdue_minor, 0) as overdue_minor,
             coalesce(pay.payments_received_minor, 0) as payments_received_minor, coalesce(exp.expenses_minor, 0) as expenses_minor
      from keys k join public.properties pr on pr.id = k.property_id
        left join c on c.property_id = k.property_id and c.currency = k.currency left join pay on pay.property_id = k.property_id and pay.currency = k.currency left join exp on exp.property_id = k.property_id and exp.currency = k.currency)
    select jsonb_agg(to_jsonb(r) || jsonb_build_object(
        'collection_rate_bps', case when billed_minor = 0 then null else (collected_minor * 10000) / billed_minor end,
        'net_cash_minor', payments_received_minor - expenses_minor) order by property_name, currency)
    from rows_ r), '[]'::jsonb);
end $$;

grant execute on function public.property_performance(uuid, date, date, uuid, text) to authenticated;
