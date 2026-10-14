-- RLS + the private maintenance-attachments bucket. API roles can only read (staff+); writes go through functions.
-- Tenants (portal users) are not organization members, so they have NO table access: they use the portal functions.

revoke all on public.tenant_users, public.tenant_invitations, public.vendors, public.urgency_levels, public.maintenance_settings,
  public.maintenance_requests, public.maintenance_status_history, public.maintenance_notes, public.work_orders, public.work_order_estimates,
  public.maintenance_attachments, public.notification_event_types, public.notification_prefs, public.notifications, public.email_queue,
  public.job_runs, public.approval_actions, public.approvals from anon, authenticated;
grant select on public.vendors, public.urgency_levels, public.maintenance_requests, public.maintenance_status_history, public.maintenance_notes,
  public.work_orders, public.work_order_estimates, public.maintenance_attachments, public.notification_event_types, public.notification_prefs,
  public.notifications, public.approval_actions, public.approvals to authenticated;

do $$
declare t text;
begin
  foreach t in array array['vendors','urgency_levels','maintenance_requests','maintenance_status_history','maintenance_notes','work_orders',
                           'work_order_estimates','maintenance_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (app.has_role(org_id, ''staff''))', t, t);
  end loop;
  foreach t in array array['tenant_users','tenant_invitations','maintenance_settings','email_queue','job_runs'] loop
    execute format('alter table public.%I enable row level security', t);       -- no policy: reachable only through functions
  end loop;
end $$;

-- Approvals are visible to anyone who could act on them or asked for them.
alter table public.approvals enable row level security;
drop policy if exists approvals_select on public.approvals;
create policy approvals_select on public.approvals for select to authenticated
  using (requested_by = (select auth.uid()) or app.has_role(org_id, 'manager'));
alter table public.approval_actions enable row level security;
drop policy if exists approval_actions_select on public.approval_actions;
create policy approval_actions_select on public.approval_actions for select to authenticated using (true);
alter table public.notification_event_types enable row level security;
drop policy if exists event_types_select on public.notification_event_types;
create policy event_types_select on public.notification_event_types for select to authenticated using (true);

-- Personal data: only your own notifications and preferences.
alter table public.notifications enable row level security;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated using (user_id = (select auth.uid()));
alter table public.notification_prefs enable row level security;
drop policy if exists notification_prefs_select on public.notification_prefs;
create policy notification_prefs_select on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()));

-- ------------------------------------------------------------------ storage
-- Access to a maintenance attachment is derived from the request it belongs to: staff+ of the org, or the verified tenant who
-- reported the request (for files they may see). Same pattern as lease documents.
create or replace function app.tenant_reported(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.maintenance_requests r join public.tenant_users tu on tu.org_id = r.org_id and tu.tenant_id = r.tenant_id
    where r.id = p_request and tu.user_id = (select auth.uid()) and tu.revoked_at is null)
$$;

create or replace function app.can_access_attachment_object(p_name text, p_status public.document_status, p_for_upload boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.maintenance_attachments a
    where a.storage_path = p_name and a.status = p_status and a.archived_at is null
      and (
        (p_for_upload and a.uploaded_by = (select auth.uid()) and (app.has_role(a.org_id, 'staff') or app.tenant_reported(a.request_id)))
        or (not p_for_upload and (app.has_role(a.org_id, 'staff') or (a.visibility = 'tenant' and app.tenant_reported(a.request_id))))))
$$;
create or replace function app.can_verify_pending_attachment(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.maintenance_attachments a where a.storage_path = p_name and a.status = 'pending' and a.uploaded_by = (select auth.uid()))
$$;
revoke all on function app.tenant_reported(uuid), app.can_access_attachment_object(text, public.document_status, boolean), app.can_verify_pending_attachment(text) from public, anon;
grant execute on function app.tenant_reported(uuid), app.can_access_attachment_object(text, public.document_status, boolean), app.can_verify_pending_attachment(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maintenance-attachments', 'maintenance-attachments', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists maintenance_obj_select on storage.objects;
create policy maintenance_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'maintenance-attachments' and (app.can_access_attachment_object(name, 'available', false) or app.can_verify_pending_attachment(name)));
drop policy if exists maintenance_obj_insert on storage.objects;
create policy maintenance_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'maintenance-attachments' and app.can_access_attachment_object(name, 'pending', true));
