-- RLS for Phase 2 tables + the private lease-document bucket and its policies.
-- Read access: any member (viewer+) for structured records; documents need staff+.
-- All writes go through SECURITY DEFINER functions (next migration): no write grants.

revoke all on public.properties, public.owners, public.property_owners, public.units, public.tenants,
  public.tenancies, public.tenancy_tenants, public.leases, public.lease_documents from anon, authenticated;
grant select on public.properties, public.owners, public.property_owners, public.units, public.tenants,
  public.tenancies, public.tenancy_tenants, public.leases, public.lease_documents to authenticated;

do $$
declare t text;
begin
  foreach t in array array['properties','owners','property_owners','units','tenants','tenancies','tenancy_tenants','leases'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (app.is_member(org_id))', t, t);
  end loop;
end $$;

alter table public.lease_documents enable row level security;
drop policy if exists lease_documents_select on public.lease_documents;
create policy lease_documents_select on public.lease_documents for select to authenticated
  using (app.has_role(org_id, 'staff'));

-- -------------------------------------------------------------------- storage
-- Object access is derived from the lease_documents row that owns the path, so a file is
-- reachable only by members with the right role in the document's own organization.
create or replace function app.can_access_document_object(
  p_name text, p_min public.org_role, p_status public.document_status) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.lease_documents d
    where d.storage_path = p_name and d.status = p_status and app.has_role(d.org_id, p_min))
$$;
-- The uploader may read back their own still-pending object so the server can verify the upload
-- (size/type) before the document is confirmed. Nobody else can read pending files.
create or replace function app.can_verify_pending_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.lease_documents d
    where d.storage_path = p_name and d.status = 'pending'
      and d.uploaded_by = (select auth.uid()) and app.has_role(d.org_id, 'staff'))
$$;
revoke all on function app.can_access_document_object(text, public.org_role, public.document_status) from public, anon;
revoke all on function app.can_verify_pending_object(text) from public, anon;
grant execute on function app.can_access_document_object(text, public.org_role, public.document_status) to authenticated;
grant execute on function app.can_verify_pending_object(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lease-documents', 'lease-documents', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists lease_documents_obj_select on storage.objects;
create policy lease_documents_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'lease-documents' and (app.can_access_document_object(name, 'staff', 'available')
                                            or app.can_verify_pending_object(name)));

-- Upload only to a path pre-registered by create_document (status 'pending').
drop policy if exists lease_documents_obj_insert on storage.objects;
create policy lease_documents_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'lease-documents' and app.can_access_document_object(name, 'staff', 'pending'));
-- No UPDATE/DELETE policies: stored files are immutable; "deleting" a document archives its record.
