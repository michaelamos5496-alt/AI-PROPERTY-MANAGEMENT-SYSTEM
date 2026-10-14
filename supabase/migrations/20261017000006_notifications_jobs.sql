-- Notifications API, the email delivery worker (service role only), and idempotent scheduled jobs.

-- Exact decimal text using integer arithmetic only: 123456 USD -> '1234.56', 1500 JPY -> '1500'.
create or replace function app.money_text(p_minor bigint, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select case when d = 0 then p_minor::text
    else (case when p_minor < 0 then '-' else '' end) || (abs(p_minor) / f)::text || '.' || lpad((abs(p_minor) % f)::text, d, '0') end
  from (select d, case d when 0 then 1 when 2 then 100 else 1000 end::bigint as f
          from (select case when p_currency in ('JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX') then 0 when p_currency in ('KWD', 'BHD', 'OMR', 'JOD', 'TND') then 3 else 2 end as d) a) x
$$;

-- ------------------------------------------------------------- user-facing API
create or replace function public.list_my_notifications(p_unread_only boolean default false, p_limit int default 30, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := app.require_user();
begin
  return jsonb_build_object(
    'unread', (select count(*) from public.notifications where user_id = uid and read_at is null),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'org_id', n.org_id, 'event_type', n.event_type, 'title', n.title, 'body', n.body, 'link', n.link, 'read_at', n.read_at, 'created_at', n.created_at) order by n.created_at desc)
      from (select * from public.notifications where user_id = uid and (not coalesce(p_unread_only, false) or read_at is null) order by created_at desc limit app.page_limit(p_limit) offset app.page_offset(p_offset)) n), '[]'::jsonb));
end $$;

create or replace function public.mark_my_notifications_read(p_ids jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := app.require_user(); v_n int;
begin
  update public.notifications set read_at = now() where user_id = uid and read_at is null
     and (p_ids is null or id in (select x::uuid from jsonb_array_elements_text(p_ids) x));
  get diagnostics v_n = row_count;
  return jsonb_build_object('marked', v_n);
end $$;

create or replace function public.get_my_notification_prefs(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'viewer');
  return coalesce((select jsonb_agg(jsonb_build_object('event_type', e.event_type, 'label', e.label, 'mandatory', e.mandatory,
      'email', e.mandatory or coalesce(p.email, e.default_email), 'in_app', e.mandatory or coalesce(p.in_app, e.default_in_app)) order by e.label)
    from public.notification_event_types e left join public.notification_prefs p on p.event_type = e.event_type and p.org_id = p_org and p.user_id = auth.uid()), '[]'::jsonb);
end $$;

create or replace function public.set_my_notification_pref(p_org uuid, p_event_type text, p_email boolean, p_in_app boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ev public.notification_event_types;
begin
  perform app.require_role(p_org, 'viewer');
  select * into ev from public.notification_event_types where event_type = p_event_type;
  if ev.event_type is null then raise exception 'unknown event type' using errcode = 'PT404'; end if;
  if ev.mandatory and not (coalesce(p_email, true) and coalesce(p_in_app, true)) then raise exception 'this notification cannot be turned off' using errcode = 'PT422'; end if;
  insert into public.notification_prefs (org_id, user_id, event_type, email, in_app) values (p_org, auth.uid(), p_event_type, coalesce(p_email, ev.default_email), coalesce(p_in_app, ev.default_in_app))
  on conflict (org_id, user_id, event_type) do update set email = excluded.email, in_app = excluded.in_app, updated_at = now();
  return public.get_my_notification_prefs(p_org);
end $$;

-- Delivery visibility for managers: what is queued, what failed, why.
create or replace function public.list_email_queue(p_org uuid, p_status public.email_status default null, p_limit int default 25, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.email_queue where org_id = p_org group by status) c), '{}'::jsonb),
    'total', (select count(*) from public.email_queue where org_id = p_org and (p_status is null or status = p_status)),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'recipient_email', q.recipient_email, 'recipient_name', q.recipient_name, 'event_type', q.event_type, 'subject', q.subject,
        'status', q.status, 'attempts', q.attempts, 'max_attempts', q.max_attempts, 'next_attempt_at', q.next_attempt_at, 'last_error', q.last_error, 'sent_at', q.sent_at, 'created_at', q.created_at, 'requeued_count', q.requeued_count) order by q.created_at desc)
      from (select * from public.email_queue where org_id = p_org and (p_status is null or status = p_status) order by created_at desc limit app.page_limit(p_limit) offset app.page_offset(p_offset)) q), '[]'::jsonb));
end $$;

create or replace function public.requeue_email(p_org uuid, p_email uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.email_queue;
begin
  perform app.require_role(p_org, 'manager');
  select * into q from public.email_queue where id = p_email and org_id = p_org for update;
  if q.id is null then raise exception 'email not found' using errcode = 'PT404'; end if;
  if q.status not in ('failed', 'dead') then raise exception 'only failed emails can be retried' using errcode = 'PT409'; end if;
  update public.email_queue set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, locked_by = null, locked_until = null, requeued_count = requeued_count + 1 where id = p_email;
  return jsonb_build_object('id', p_email, 'status', 'queued');
end $$;

-- ---------------------------------------------------- delivery worker (service role)
-- Claims a batch with FOR UPDATE SKIP LOCKED: concurrent workers never receive the same email. A claim is a lease;
-- if the worker dies, the lease expires and the email becomes claimable again (counted as an attempt).
create or replace function public.claim_emails(p_worker text, p_limit int default 10, p_lease_seconds int default 120) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from (
    select id from public.email_queue
     where ((status in ('queued', 'failed') and next_attempt_at <= now()) or (status = 'sending' and locked_until < now()))
     order by next_attempt_at, created_at limit least(greatest(coalesce(p_limit, 10), 1), 50) for update skip locked) c;
  update public.email_queue set status = 'sending', attempts = attempts + 1, last_attempt_at = now(), locked_by = left(p_worker, 80), locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10))
   where id = any (v_ids);
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'org_id', q.org_id, 'to', q.recipient_email, 'name', q.recipient_name, 'subject', q.subject, 'body', q.body_text,
      'link', q.link, 'event_type', q.event_type, 'attempts', q.attempts, 'max_attempts', q.max_attempts, 'dedupe_key', q.dedupe_key) order by q.created_at)
    from public.email_queue q where q.id = any (v_ids)), '[]'::jsonb);
end $$;

create or replace function public.complete_email(p_id uuid, p_worker text, p_provider_message_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.email_queue;
begin
  select * into q from public.email_queue where id = p_id for update;
  if q.id is null then raise exception 'email not found' using errcode = 'PT404'; end if;
  if q.status = 'sent' then return jsonb_build_object('id', p_id, 'status', 'sent', 'replayed', true); end if;
  if q.status <> 'sending' or q.locked_by is distinct from left(p_worker, 80) then raise exception 'this email is not claimed by you' using errcode = 'PT409'; end if;
  update public.email_queue set status = 'sent', sent_at = now(), provider_message_id = left(p_provider_message_id, 200), locked_by = null, locked_until = null, last_error = null where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'sent', 'replayed', false);
end $$;

-- Retry with exponential backoff (30s, 60s, 2m, 4m … capped at 1h); permanent errors or exhausted attempts go to `dead`.
create or replace function public.fail_email(p_id uuid, p_worker text, p_error text, p_permanent boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.email_queue; v_status public.email_status;
begin
  select * into q from public.email_queue where id = p_id for update;
  if q.id is null then raise exception 'email not found' using errcode = 'PT404'; end if;
  if q.status <> 'sending' or q.locked_by is distinct from left(p_worker, 80) then raise exception 'this email is not claimed by you' using errcode = 'PT409'; end if;
  v_status := case when coalesce(p_permanent, false) or q.attempts >= q.max_attempts then 'dead' else 'failed' end;
  update public.email_queue set status = v_status, last_error = left(coalesce(p_error, 'unknown error'), 500), locked_by = null, locked_until = null,
    next_attempt_at = now() + make_interval(secs => least(3600, 30 * (2 ^ greatest(q.attempts - 1, 0))::int)) where id = p_id;
  return jsonb_build_object('id', p_id, 'status', v_status, 'attempts', q.attempts);
end $$;

-- ------------------------------------------------------------------- jobs
create or replace function app.job_rent_due(p_org uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare c record; tn record; v_stage text; v_days int; v_n int := 0; v_ins boolean; v_subject text; v_body text;
begin
  for c in select cs.*, t.status as tenancy_status, u.reference as unit_ref, pr.name as property_name
             from app.charge_state cs join public.tenancies t on t.id = cs.tenancy_id join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id
            where cs.org_id = p_org and cs.voided_at is null and cs.outstanding_minor > 0 and t.status = 'active'
              and cs.due_date between cs.today - 30 and cs.today + 3 loop
    v_days := c.due_date - c.today;
    v_stage := case when v_days >= 1 then 'before' when v_days >= -2 then 'due' else 'overdue' end;
    v_subject := case v_stage when 'before' then 'Rent due soon: ' || app.money_text(c.outstanding_minor, c.currency) || ' ' || c.currency || ' on ' || c.due_date
                              when 'due' then 'Rent due: ' || app.money_text(c.outstanding_minor, c.currency) || ' ' || c.currency
                              else 'Rent overdue: ' || app.money_text(c.outstanding_minor, c.currency) || ' ' || c.currency end;
    v_body := 'This is a reminder for ' || c.property_name || ', unit ' || c.unit_ref || E'.\n\n' || c.description || E'\nAmount outstanding: ' || app.money_text(c.outstanding_minor, c.currency) || ' ' || c.currency ||
              E'\nDue date: ' || c.due_date || E'\n\nIf you have already paid, thank you; please ignore this message.';
    for tn in select te.id, te.full_name, te.email from public.tenancy_tenants tt join public.tenants te on te.id = tt.tenant_id
               where tt.tenancy_id = c.tenancy_id and te.email is not null and te.archived_at is null and not te.reminders_opt_out loop
      v_ins := app.notify_email(p_org, tn.email, tn.full_name, 'reminder.rent_due', v_subject, v_body, null, 'rent:' || c.id || ':' || v_stage || ':' || tn.id);
      if v_ins then v_n := v_n + 1; end if;
    end loop;
  end loop;
  return v_n;
end $$;

create or replace function app.job_lease_expiry(p_org uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare x record; v_left int; v_stage int; v_n int := 0;
begin
  for x in select t.id, t.end_date, u.reference as unit_ref, pr.name as property_name, app.property_today(pr.id) as today, app.primary_tenant_name(t.id) as tenant
             from public.tenancies t join public.units u on u.id = t.unit_id join public.properties pr on pr.id = u.property_id
            where t.org_id = p_org and t.status = 'active' and t.end_date is not null loop
    v_left := x.end_date - x.today;
    continue when v_left < 0 or v_left > 60;
    -- the smallest threshold that still covers the days left, so a late first run sends one reminder rather than several
    v_stage := (select min(s) from unnest(array[7, 14, 30, 60]) s where s >= v_left);
    v_n := v_n + app.notify_role(p_org, 'manager', 'reminder.lease_expiry', 'Lease ending in ' || v_left || ' day' || case when v_left = 1 then '' else 's' end || ': ' || x.property_name || ' · ' || x.unit_ref,
      coalesce(x.tenant, 'The tenant') || '’s tenancy ends on ' || x.end_date || '. Decide whether to renew, end or convert it to a periodic tenancy.',
      '/app?org=' || p_org || '#/tenancies/' || x.id, 'lease:' || x.id || ':' || x.end_date || ':' || v_stage);
  end loop;
  return v_n;
end $$;

create or replace function app.job_escalation_followups(p_org uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; s public.maintenance_settings; v_bucket int; v_n int := 0; v_title text; v_link text;
begin
  s := app.settings(p_org);
  for r in select * from public.maintenance_requests where org_id = p_org and escalation_required and escalated_at is not null and escalation_ack_at is null and status not in ('resolved', 'cancelled')
                    and escalated_at <= now() - make_interval(hours => s.ack_hours) loop
    v_bucket := least(20, greatest(1, floor(extract(epoch from (now() - r.escalated_at)) / 3600 / s.ack_hours)::int));
    v_title := 'STILL UNACKNOWLEDGED: ' || r.title;
    v_link := '/app?org=' || p_org || '#/maintenance/' || r.id;
    if r.escalated_to is not null then
      if app.notify_user(p_org, r.escalated_to, 'maintenance.escalated', v_title, 'A critical issue has not been acknowledged.', v_link, 'mr:' || r.id || ':esc:' || v_bucket) then v_n := v_n + 1; end if;
      if s.backup_user_id is not null and s.backup_user_id <> r.escalated_to and v_bucket >= 2 then
        if app.notify_user(p_org, s.backup_user_id, 'maintenance.escalated', v_title, 'A critical issue has not been acknowledged.', v_link, 'mr:' || r.id || ':esc:' || v_bucket) then v_n := v_n + 1; end if;
      end if;
    end if;
    if r.escalated_to is null or v_bucket >= 3 then      -- widen the net: no designee, or still ignored after several windows
      v_n := v_n + app.notify_role(p_org, 'admin', 'maintenance.escalated', v_title, 'A critical issue has not been acknowledged.', v_link, 'mr:' || r.id || ':esc:' || v_bucket);
    end if;
  end loop;
  return v_n;
end $$;

create or replace function app.job_expire_approvals(p_org uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare a public.approvals; v_n int := 0;
begin
  for a in select * from public.approvals where org_id = p_org and status in ('pending', 'approved') and expires_at <= now() for update skip locked loop
    perform app.approval_set(a.id, 'expired', null, 'expired');
    perform app.notify_user(p_org, a.requested_by, 'approval.decided', 'Approval expired: ' || (select label from public.approval_actions where action_type = a.action_type), 'It was not decided in time. Request it again if it is still needed.',
      '/app?org=' || p_org || '#/approvals/' || a.id, 'ap:' || a.id || ':expired');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- One org, all jobs. Each job takes a non-blocking lock, so overlapping runs skip instead of doing the work twice,
-- and every job is idempotent by dedupe key, so re-running (or overlapping) can never duplicate a reminder.
create or replace function app.run_jobs_for_org(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j text; v_run bigint; v_n int; v_out jsonb := '{}'::jsonb;
begin
  foreach j in array array['rent_due_reminders', 'lease_expiry_reminders', 'escalation_followups', 'expire_approvals'] loop
    if not pg_try_advisory_xact_lock(hashtextextended('job:' || j || ':' || p_org, 0)) then
      insert into public.job_runs (job, org_id, status, finished_at) values (j, p_org, 'skipped', now());
      v_out := v_out || jsonb_build_object(j, jsonb_build_object('skipped', true));
      continue;
    end if;
    insert into public.job_runs (job, org_id) values (j, p_org) returning id into v_run;
    begin
      v_n := case j when 'rent_due_reminders' then app.job_rent_due(p_org) when 'lease_expiry_reminders' then app.job_lease_expiry(p_org)
                    when 'escalation_followups' then app.job_escalation_followups(p_org) else app.job_expire_approvals(p_org) end;
      update public.job_runs set status = 'ok', finished_at = now(), created_count = v_n where id = v_run;
      v_out := v_out || jsonb_build_object(j, jsonb_build_object('created', v_n));
    exception when others then
      update public.job_runs set status = 'error', finished_at = now(), error = left(sqlerrm, 500) where id = v_run;
      v_out := v_out || jsonb_build_object(j, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return v_out;
end $$;

create or replace function public.run_org_jobs(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return app.run_jobs_for_org(p_org);
end $$;

-- Cron entry point: every organization, service role only.
create or replace function public.job_run_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o record; v_out jsonb := '{}'::jsonb;
begin
  for o in select id from public.organizations order by id loop
    v_out := v_out || jsonb_build_object(o.id::text, app.run_jobs_for_org(o.id));
  end loop;
  return v_out;
end $$;

create or replace function public.list_job_runs(p_org uuid, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(p_org, 'manager');
  return coalesce((select jsonb_agg(to_jsonb(j) - 'org_id' order by j.id desc) from (select * from public.job_runs where org_id = p_org order by id desc limit app.page_limit(p_limit)) j), '[]'::jsonb);
end $$;

-- Worker-only functions are NOT callable by signed-in users or anonymous callers.
revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.claim_emails(text, int, int), public.complete_email(uuid, text, text), public.fail_email(uuid, text, text, boolean), public.job_run_all() from authenticated;
grant execute on function public.claim_emails(text, int, int), public.complete_email(uuid, text, text), public.fail_email(uuid, text, text, boolean), public.job_run_all() to service_role;
grant select on public.approval_events to authenticated;
