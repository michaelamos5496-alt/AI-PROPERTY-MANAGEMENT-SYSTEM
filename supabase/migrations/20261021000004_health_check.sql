-- Phase 8: one cheap, read-only function the monitor calls. It reports what is stuck, not what is merely busy.
create or replace function public.health_svc_check() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_ch text;
begin
  select phone_number_id into v_ch from public.whatsapp_channels where enabled limit 1;
  return jsonb_build_object(
    'database', true, 'now', now(),
    'email', jsonb_build_object('queued_overdue', (select count(*) from public.email_queue where status in ('queued', 'failed') and next_attempt_at < now() - interval '15 minutes'),
                                'dead', (select count(*) from public.email_queue where status = 'dead')),
    'whatsapp', jsonb_build_object('events_stuck', (select count(*) from public.whatsapp_events where status in ('pending', 'failed', 'processing') and received_at < now() - interval '10 minutes'),
                                   'events_dead', (select count(*) from public.whatsapp_events where status = 'dead' and received_at > now() - interval '7 days'),
                                   'outbound_stuck', (select count(*) from public.whatsapp_messages where direction = 'out' and status in ('queued', 'sending') and next_attempt_at < now() - interval '15 minutes'),
                                   'outbound_dead', (select count(*) from public.whatsapp_messages where direction = 'out' and status = 'dead' and created_at > now() - interval '7 days'),
                                   'enabled_channel', v_ch),
    'billing', jsonb_build_object('events_pending', (select count(*) from public.billing_events where status = 'pending' and received_at < now() - interval '1 hour'),
                                  'past_due', (select count(*) from public.subscriptions where status = 'past_due')),
    'jobs', jsonb_build_object('last_ok_at', (select max(finished_at) from public.job_runs where job = 'scheduler' and status = 'ok'), 'errors_24h', (select count(*) from public.job_runs where status = 'error' and started_at > now() - interval '24 hours')),
    'approvals', jsonb_build_object('pending_expired', (select count(*) from public.approvals where status = 'pending' and expires_at < now() - interval '1 hour')));
end $$;
revoke execute on function public.health_svc_check() from public, anon, authenticated;
grant execute on function public.health_svc_check() to service_role;

-- The scheduler records that it ran, independent of how many organizations exist, so "the scheduler stopped" is detectable.
create or replace function public.job_svc_heartbeat(p_ok boolean, p_error text) returns void
language sql security definer set search_path = '' as $$
  insert into public.job_runs (job, org_id, started_at, finished_at, status, error) values ('scheduler', null, now(), now(), case when p_ok then 'ok' else 'error' end, left(p_error, 500)) $$;
revoke execute on function public.job_svc_heartbeat(boolean, text) from public, anon, authenticated;
grant execute on function public.job_svc_heartbeat(boolean, text) to service_role;
