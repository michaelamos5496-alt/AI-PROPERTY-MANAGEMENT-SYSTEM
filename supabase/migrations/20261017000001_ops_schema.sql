-- Phase 4: maintenance, tenant portal access, notifications, approvals.
-- Everything is org-scoped with composite (org_id, id) foreign keys; history tables are append-only.

do $$ begin create type public.maintenance_status as enum
  ('submitted','triaged','awaiting_approval','assigned','in_progress','resolved','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.work_order_status as enum ('assigned','in_progress','completed','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.maintenance_category as enum
  ('plumbing','electrical','heating_cooling','appliances','structural','pest','security','cleaning','grounds','other');
exception when duplicate_object then null; end $$;
do $$ begin create type public.note_visibility as enum ('internal','tenant');
exception when duplicate_object then null; end $$;
do $$ begin create type public.email_status as enum ('queued','sending','sent','failed','dead','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.approval_status as enum
  ('pending','approved','rejected','cancelled','expired','invalidated','executing','executed','failed');
exception when duplicate_object then null; end $$;

-- Tenants may opt out of automatic reminder emails.
alter table public.tenants add column if not exists reminders_opt_out boolean not null default false;

-- -------------------------------------------------- tenant portal access
-- A tenant record is linked to a platform user only after the user proves control of the tenant's email address
-- (invitation token + confirmed auth email). Tenant users are NOT organization members and see nothing but their own requests.
create table if not exists public.tenant_users (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  tenant_id   uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  verified_at timestamptz not null default now(),
  verified_by uuid references auth.users (id),
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  foreign key (org_id, tenant_id) references public.tenants (org_id, id) on delete restrict
);
create unique index if not exists tenant_users_active_idx on public.tenant_users (org_id, tenant_id, user_id) where revoked_at is null;
create index if not exists tenant_users_user_idx on public.tenant_users (user_id) where revoked_at is null;

create table if not exists public.tenant_invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  tenant_id   uuid not null,
  email       text not null check (email = lower(email) and char_length(email) <= 254),
  token_hash  text not null unique,
  invited_by  uuid not null references auth.users (id),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (org_id, tenant_id) references public.tenants (org_id, id) on delete restrict
);
create unique index if not exists tenant_invitations_pending_idx on public.tenant_invitations (org_id, tenant_id) where accepted_at is null and revoked_at is null;

-- ------------------------------------------------------------------ vendors
create table if not exists public.vendors (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete restrict,
  name         text not null check (char_length(btrim(name)) between 1 and 160),
  contact_name text check (char_length(contact_name) <= 160),
  email        text check (char_length(email) <= 254),
  phone        text check (char_length(phone) <= 40),
  categories   public.maintenance_category[] not null default '{}',
  notes        text check (char_length(notes) <= 4000),
  version      int not null default 1,
  archived_at  timestamptz,
  created_by   uuid not null references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, id)
);

-- ------------------------------------------------- configurable urgency
create table if not exists public.urgency_levels (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  key              text not null check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label            text not null check (char_length(btrim(label)) between 1 and 60),
  rank             int not null check (rank between 1 and 1000),       -- higher = more urgent
  is_critical      boolean not null default false,                      -- critical levels always escalate to a human
  tenant_selectable boolean not null default true,
  is_default       boolean not null default false,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, key)
);
create unique index if not exists urgency_one_default_idx on public.urgency_levels (org_id) where is_default and archived_at is null;

create table if not exists public.maintenance_settings (
  org_id               uuid primary key references public.organizations (id) on delete restrict,
  escalation_user_id   uuid references auth.users (id),
  backup_user_id       uuid references auth.users (id),
  critical_keywords    text[] not null default array['gas leak','smell gas','carbon monoxide','fire','smoke','flood','flooding','burst pipe','sewage','no heating','no heat','exposed wire','sparking','electric shock','break-in','broken lock','collapsed','ceiling collapse','mold','locked out'],
  ack_hours            int not null default 2 check (ack_hours between 1 and 72),
  approval_thresholds  jsonb not null default '{}'::jsonb,   -- {"USD": 50000}: estimates at or below auto-approve; absent = always approve
  allow_self_approval  boolean not null default false,
  updated_by           uuid references auth.users (id),
  updated_at           timestamptz not null default now()
);

-- ----------------------------------------------------------------- requests
create table if not exists public.maintenance_requests (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null,
  property_id           uuid not null,
  unit_id               uuid,
  tenancy_id            uuid,
  tenant_id             uuid,                              -- the tenant who reported it (portal), if any
  reported_by           uuid not null references auth.users (id),
  reported_via          text not null check (reported_via in ('staff', 'tenant')),
  title                 text not null check (char_length(btrim(title)) between 3 and 160),
  description           text not null check (char_length(btrim(description)) between 1 and 4000),
  category              public.maintenance_category not null default 'other',
  urgency_id            uuid not null,
  initial_urgency_id    uuid not null,
  suggested_urgency_id  uuid,                              -- advisory only (e.g. a future AI classifier); can only RAISE urgency handling
  suggestion_source     text check (char_length(suggestion_source) <= 60),
  safety_flag           boolean not null default false,    -- deterministic keyword match on the text
  escalation_required   boolean not null default false,    -- sticky: never cleared automatically
  escalated_at          timestamptz,
  escalated_to          uuid references auth.users (id),
  escalation_fallback   boolean not null default false,
  escalation_ack_at     timestamptz,
  escalation_ack_by     uuid references auth.users (id),
  status                public.maintenance_status not null default 'submitted',
  triaged_at            timestamptz,
  resolved_at           timestamptz,
  resolved_by           uuid references auth.users (id),
  resolution_notes      text check (char_length(resolution_notes) <= 4000),
  cancelled_at          timestamptz,
  cancelled_by          uuid references auth.users (id),
  cancel_reason         text check (char_length(cancel_reason) <= 500),
  version               int not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (org_id, property_id) references public.properties (org_id, id) on delete restrict,
  foreign key (org_id, property_id, unit_id) references public.units (org_id, property_id, id) on delete restrict,
  foreign key (org_id, tenancy_id) references public.tenancies (org_id, id) on delete restrict,
  foreign key (org_id, tenant_id) references public.tenants (org_id, id) on delete restrict,
  foreign key (org_id, urgency_id) references public.urgency_levels (org_id, id) on delete restrict,
  foreign key (org_id, initial_urgency_id) references public.urgency_levels (org_id, id) on delete restrict,
  foreign key (org_id, suggested_urgency_id) references public.urgency_levels (org_id, id) on delete restrict,
  unique (org_id, id),
  check (status <> 'resolved' or (resolution_notes is not null and char_length(btrim(resolution_notes)) >= 3 and resolved_at is not null)),
  check (status <> 'cancelled' or (cancel_reason is not null and cancelled_at is not null)),
  check (escalated_at is null or escalation_required)
);
create index if not exists maintenance_requests_org_idx on public.maintenance_requests (org_id, status, created_at desc);
create index if not exists maintenance_requests_property_idx on public.maintenance_requests (property_id);
create index if not exists maintenance_requests_unacked_idx on public.maintenance_requests (org_id) where escalation_required and escalation_ack_at is null;

create table if not exists public.maintenance_status_history (
  id          bigint generated always as identity primary key,
  org_id      uuid not null,
  request_id  uuid not null,
  from_status public.maintenance_status,
  to_status   public.maintenance_status not null,
  actor_id    uuid references auth.users (id),            -- null = system
  note        text check (char_length(note) <= 1000),
  created_at  timestamptz not null default now(),
  foreign key (org_id, request_id) references public.maintenance_requests (org_id, id) on delete restrict
);
create index if not exists maintenance_history_idx on public.maintenance_status_history (request_id, id);

create table if not exists public.maintenance_notes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  request_id  uuid not null,
  author_id   uuid references auth.users (id),
  author_kind text not null check (author_kind in ('staff', 'tenant', 'system')),
  visibility  public.note_visibility not null default 'internal',
  body        text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now(),
  foreign key (org_id, request_id) references public.maintenance_requests (org_id, id) on delete restrict
);
create index if not exists maintenance_notes_idx on public.maintenance_notes (request_id, created_at);

-- -------------------------------------------------------------- work orders
create table if not exists public.work_orders (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  request_id          uuid not null,
  vendor_id           uuid,
  assignee_user_id    uuid references auth.users (id),
  scope               text not null check (char_length(btrim(scope)) between 1 and 2000),
  status              public.work_order_status not null default 'assigned',
  currency            char(3) not null check (currency ~ '^[A-Z]{3}$'),
  current_estimate_id uuid,
  approved_cost_minor bigint check (approved_cost_minor is null or (approved_cost_minor > 0 and approved_cost_minor <= 1000000000000)),
  approved_at         timestamptz,
  approved_by         uuid references auth.users (id),
  actual_cost_minor   bigint check (actual_cost_minor is null or (actual_cost_minor >= 0 and actual_cost_minor <= 1000000000000)),
  started_at          timestamptz,
  completed_at        timestamptz,
  completion_notes    text check (char_length(completion_notes) <= 2000),
  cancelled_at        timestamptz,
  cancel_reason       text check (char_length(cancel_reason) <= 500),
  assigned_by         uuid not null references auth.users (id),
  version             int not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (org_id, request_id) references public.maintenance_requests (org_id, id) on delete restrict,
  foreign key (org_id, vendor_id) references public.vendors (org_id, id) on delete restrict,
  unique (org_id, id),
  check (num_nonnulls(vendor_id, assignee_user_id) = 1),             -- exactly one assignee: a vendor OR a staff member
  check (status <> 'cancelled' or cancelled_at is not null),
  check (status <> 'completed' or completed_at is not null)
);
create index if not exists work_orders_request_idx on public.work_orders (request_id);
create index if not exists work_orders_assignee_idx on public.work_orders (assignee_user_id) where assignee_user_id is not null;

create table if not exists public.work_order_estimates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  work_order_id uuid not null,
  amount_minor  bigint not null check (amount_minor > 0 and amount_minor <= 1000000000000),
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  description   text check (char_length(description) <= 1000),
  submitted_by  uuid not null references auth.users (id),
  superseded_at timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (org_id, work_order_id) references public.work_orders (org_id, id) on delete restrict,
  unique (org_id, id)
);
create index if not exists estimates_wo_idx on public.work_order_estimates (work_order_id, created_at);

create table if not exists public.maintenance_attachments (
  id            uuid primary key,
  org_id        uuid not null,
  request_id    uuid not null,
  file_name     text not null check (char_length(file_name) between 1 and 200),
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  storage_path  text not null unique,
  status        public.document_status not null default 'pending',
  uploaded_by   uuid not null references auth.users (id),
  uploader_kind text not null check (uploader_kind in ('staff', 'tenant')),
  visibility    public.note_visibility not null default 'internal',
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (org_id, request_id) references public.maintenance_requests (org_id, id) on delete restrict
);
create index if not exists maintenance_attachments_idx on public.maintenance_attachments (request_id);

-- ------------------------------------------------------------ notifications
create table if not exists public.notification_event_types (
  event_type     text primary key,
  label          text not null,
  default_email  boolean not null default true,
  default_in_app boolean not null default true,
  mandatory      boolean not null default false     -- cannot be switched off (e.g. critical escalations)
);
insert into public.notification_event_types (event_type, label, default_email, default_in_app, mandatory) values
  ('maintenance.submitted',  'New maintenance request',                true,  true,  false),
  ('maintenance.escalated',  'Critical maintenance escalation',        true,  true,  true),
  ('maintenance.status',     'Maintenance request status changes',     true,  true,  false),
  ('maintenance.assigned',   'Work assigned to you',                   true,  true,  false),
  ('maintenance.note',       'New note on a maintenance request',      false, true,  false),
  ('approval.requested',     'Approval needed',                        true,  true,  false),
  ('approval.decided',       'Approval decision',                      true,  true,  false),
  ('reminder.rent_due',      'Rent due reminder',                      true,  true,  false),
  ('reminder.lease_expiry',  'Lease expiry reminder',                  true,  true,  false)
on conflict (event_type) do nothing;

create table if not exists public.notification_prefs (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  event_type text not null references public.notification_event_types (event_type),
  email      boolean not null,
  in_app     boolean not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id, event_type)
);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete restrict,
  user_id    uuid not null references auth.users (id) on delete cascade,
  event_type text not null references public.notification_event_types (event_type),
  title      text not null check (char_length(title) <= 200),
  body       text check (char_length(body) <= 2000),
  link       text check (char_length(link) <= 300),
  dedupe_key text not null,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- Durable outbound email queue. A worker claims rows (SKIP LOCKED), sends, then marks them sent/failed/dead.
create table if not exists public.email_queue (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete restrict,
  recipient_email     text not null check (char_length(recipient_email) <= 254),
  recipient_user_id   uuid references auth.users (id) on delete set null,
  recipient_name      text check (char_length(recipient_name) <= 160),
  event_type          text not null references public.notification_event_types (event_type),
  subject             text not null check (char_length(subject) <= 200),
  body_text           text not null check (char_length(body_text) <= 8000),
  link                text check (char_length(link) <= 300),
  dedupe_key          text not null check (char_length(dedupe_key) <= 300),
  status              public.email_status not null default 'queued',
  attempts            int not null default 0,
  max_attempts        int not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at     timestamptz not null default now(),
  last_attempt_at     timestamptz,
  locked_by           text,
  locked_until        timestamptz,
  last_error          text check (char_length(last_error) <= 500),
  provider_message_id text,
  sent_at             timestamptz,
  requeued_count      int not null default 0,
  created_at          timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index if not exists email_queue_due_idx on public.email_queue (next_attempt_at) where status in ('queued', 'failed');
create index if not exists email_queue_org_status_idx on public.email_queue (org_id, status, created_at desc);

create table if not exists public.job_runs (
  id            bigint generated always as identity primary key,
  job           text not null,
  org_id        uuid references public.organizations (id) on delete set null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_count int not null default 0,
  status        text not null default 'running' check (status in ('running', 'ok', 'error', 'skipped')),
  error         text check (char_length(error) <= 500)
);
create index if not exists job_runs_idx on public.job_runs (job, started_at desc);

-- ---------------------------------------------------------------- approvals
create table if not exists public.approval_actions (
  action_type       text primary key,
  label             text not null,
  description       text not null,
  request_min_role  public.org_role not null,
  approve_min_role  public.org_role not null
);
insert into public.approval_actions (action_type, label, description, request_min_role, approve_min_role) values
  ('maintenance.approve_cost', 'Approve maintenance cost', 'Authorizes the estimated cost of a work order so the work can proceed.', 'staff', 'manager'),
  ('finance.void_charge',      'Void a charge',            'Voids a rent or fee charge. The charge stays on record as void.',               'staff', 'manager')
on conflict (action_type) do nothing;

create table if not exists public.approvals (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  action_type        text not null references public.approval_actions (action_type),
  requested_by       uuid not null references auth.users (id),
  requested_at       timestamptz not null default now(),
  request_note       text check (char_length(request_note) <= 1000),
  status             public.approval_status not null default 'pending',
  target_type        text not null,
  target_id          uuid not null,
  payload            jsonb not null,                       -- the exact proposed action; immutable
  payload_hash       text not null,                        -- sha256 of the canonical payload text; immutable
  target_fingerprint text not null,                        -- hash of the target's relevant state when proposed; immutable
  expires_at         timestamptz not null,
  decided_by         uuid references auth.users (id),
  decided_at         timestamptz,
  decision_note      text check (char_length(decision_note) <= 1000),
  execution_started  timestamptz,
  executed_at        timestamptz,
  execution_attempts int not null default 0,
  execution_result   jsonb,
  execution_error    text check (char_length(execution_error) <= 500),
  execution_key      text generated always as ('approval:' || id::text) stored,   -- idempotency key for external side effects
  created_at         timestamptz not null default now(),
  unique (org_id, id)
);
create unique index if not exists approvals_live_target_idx on public.approvals (org_id, action_type, target_id) where status in ('pending', 'approved', 'executing');
create index if not exists approvals_org_status_idx on public.approvals (org_id, status, requested_at desc);

-- ------------------------------------------------------------------ guards
do $$
declare r record;
begin
  for r in select * from (values
    ('maintenance_status_history', array[]::text[]),
    ('maintenance_notes',          array[]::text[]),
    ('work_order_estimates',       array['superseded_at'])) v(t, cols)
  loop
    execute format('drop trigger if exists %I_guard on public.%I', r.t, r.t);
    execute format('create trigger %I_guard before update or delete on public.%I for each row execute function app.finance_guard(%s)',
      r.t, r.t, coalesce((select string_agg(quote_literal(c), ',') from unnest(r.cols) c), ''));
  end loop;
  for r in select * from (values ('vendors'), ('work_orders'), ('maintenance_requests')) v(t) loop
    execute format('drop trigger if exists %I_touch on public.%I', r.t, r.t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function app.touch_updated_at()', r.t, r.t);
  end loop;
end $$;

drop trigger if exists maintenance_requests_immutable on public.maintenance_requests;
create trigger maintenance_requests_immutable before update on public.maintenance_requests
  for each row execute function app.forbid_column_change('org_id', 'property_id', 'unit_id', 'reported_by', 'reported_via', 'tenant_id', 'created_at', 'initial_urgency_id');
drop trigger if exists work_orders_immutable on public.work_orders;
create trigger work_orders_immutable before update on public.work_orders
  for each row execute function app.forbid_column_change('org_id', 'request_id', 'vendor_id', 'assignee_user_id', 'currency', 'assigned_by', 'created_at');

-- Approvals: the proposal is immutable; only status/decision/execution bookkeeping may change.
drop trigger if exists approvals_guard on public.approvals;
create trigger approvals_guard before update or delete on public.approvals
  for each row execute function app.finance_guard('status', 'decided_by', 'decided_at', 'decision_note', 'execution_started', 'executed_at',
    'execution_attempts', 'execution_result', 'execution_error', 'execution_key' /* generated from id; listed because it is recomputed during UPDATE */);

-- Valid lifecycle, enforced by the database regardless of which code path asks.
create or replace function app.maintenance_transition_ok(f public.maintenance_status, t public.maintenance_status) returns boolean
language sql immutable set search_path = '' as $$
  select (f = 'submitted' and t in ('triaged', 'cancelled'))
      or (f = 'triaged' and t in ('awaiting_approval', 'assigned', 'cancelled'))
      or (f = 'awaiting_approval' and t in ('assigned', 'triaged', 'cancelled'))
      or (f = 'assigned' and t in ('in_progress', 'awaiting_approval', 'triaged', 'cancelled'))
      or (f = 'in_progress' and t in ('resolved', 'assigned', 'awaiting_approval', 'cancelled'))
      or (f = 'resolved' and t = 'in_progress')           -- reopen
$$;

create or replace function app.enforce_maintenance_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not app.maintenance_transition_ok(old.status, new.status) then
    raise exception 'illegal maintenance status change % -> %', old.status, new.status using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_requests_transition on public.maintenance_requests;
create trigger maintenance_requests_transition before update on public.maintenance_requests
  for each row execute function app.enforce_maintenance_transition();

create or replace function app.approval_transition_ok(f public.approval_status, t public.approval_status) returns boolean
language sql immutable set search_path = '' as $$
  select (f = 'pending' and t in ('approved', 'rejected', 'cancelled', 'expired', 'invalidated'))
      or (f = 'approved' and t in ('executing', 'cancelled', 'expired', 'invalidated'))
      or (f = 'executing' and t in ('executed', 'failed', 'invalidated'))
      or (f = 'failed' and t in ('executing', 'cancelled', 'invalidated'))
$$;
create or replace function app.enforce_approval_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not app.approval_transition_ok(old.status, new.status) then
    raise exception 'illegal approval status change % -> %', old.status, new.status using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists approvals_transition on public.approvals;
create trigger approvals_transition before update on public.approvals for each row execute function app.enforce_approval_transition();

-- A work order's "exactly one live estimate" and cost invariants are kept by the functions; these guard the rest.
create or replace function app.enforce_work_order_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'assigned' and new.status in ('in_progress', 'cancelled')) or
       (old.status = 'in_progress' and new.status in ('completed', 'assigned', 'cancelled'))) then
    raise exception 'illegal work order status change % -> %', old.status, new.status using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists work_orders_transition on public.work_orders;
create trigger work_orders_transition before update on public.work_orders for each row execute function app.enforce_work_order_status();
