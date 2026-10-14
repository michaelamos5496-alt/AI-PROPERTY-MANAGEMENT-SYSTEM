-- Phase 6: WhatsApp tenant assistant (Meta WhatsApp Business Platform Cloud API).
-- Everything that arrives is stored first (durable inbox), deduplicated on Meta's own ids, and processed by workers.
-- A phone number is never proof of identity: contacts start 'unverified' and are linked to a tenant only by a single-use code
-- that staff issued for that tenant. Routing is by the business phone number id, so each organization's conversations stay separate.

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.maintenance_requests'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%reported_via%';
  if c is not null then execute format('alter table public.maintenance_requests drop constraint %I', c); end if;
  alter table public.maintenance_requests add constraint maintenance_requests_reported_via_check check (reported_via in ('staff', 'tenant', 'whatsapp'));
end $$;

create table if not exists public.whatsapp_channels (
  org_id                  uuid primary key references public.organizations (id) on delete restrict,
  phone_number_id         text not null unique check (phone_number_id ~ '^[0-9]{5,30}$'),      -- Meta's id for the business number (NOT the number itself)
  display_number          text check (char_length(display_number) <= 40),
  waba_id                 text check (waba_id is null or waba_id ~ '^[0-9]{5,30}$'),
  enabled                 boolean not null default false,
  -- Maintenance requests logged from chat are attributed to this member (a manager or above) and marked as WhatsApp-sourced.
  intake_user_id          uuid not null references auth.users (id),
  -- Who is alerted for urgent or sensitive conversations. Falls back to the maintenance escalation contact, then to all admins.
  urgent_contact_user_id  uuid references auth.users (id),
  welcome_text            text check (char_length(welcome_text) <= 600),
  rent_template_name      text check (rent_template_name is null or rent_template_name ~ '^[a-z0-9_]{1,255}$'),
  rent_template_lang      text not null default 'en' check (rent_template_lang ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  rent_template_body      text check (char_length(rent_template_body) <= 1024),             -- the approved wording, with {{1}} {{2}} {{3}}, for previews
  update_template_name    text check (update_template_name is null or update_template_name ~ '^[a-z0-9_]{1,255}$'),
  update_template_lang    text not null default 'en' check (update_template_lang ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  updated_by              uuid references auth.users (id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists public.whatsapp_faqs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  question    text not null check (char_length(btrim(question)) between 3 and 200),
  keywords    text[] not null default '{}' check (cardinality(keywords) <= 30),
  answer      text not null check (char_length(btrim(answer)) between 1 and 1000),
  active      boolean not null default true,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists whatsapp_faqs_org_idx on public.whatsapp_faqs (org_id, active);

-- One row per (organization, WhatsApp number). The same person writing to two organizations is two unrelated contacts.
create table if not exists public.whatsapp_contacts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete restrict,
  wa_id             text not null check (wa_id ~ '^[0-9]{5,20}$'),
  profile_name      text check (char_length(profile_name) <= 120),
  status            text not null default 'unverified' check (status in ('unverified', 'verified', 'blocked')),
  tenant_id         uuid,
  verified_at       timestamptz,
  verified_via      uuid,                                       -- the link code that proved it
  consent           text not null default 'none' check (consent in ('none', 'opted_in', 'opted_out')),
  consent_at        timestamptz,
  opt_out_at        timestamptz,
  last_inbound_at   timestamptz,                                 -- start of the 24-hour customer-service window
  link_fail_count   int not null default 0,
  link_fail_since   timestamptz,
  link_locked_until timestamptz,
  created_at        timestamptz not null default now(),
  unique (org_id, wa_id),
  unique (org_id, id),
  foreign key (org_id, tenant_id) references public.tenants (org_id, id) on delete restrict,
  check ((status = 'verified') = (tenant_id is not null and verified_at is not null))
);
create index if not exists whatsapp_contacts_tenant_idx on public.whatsapp_contacts (org_id, tenant_id);

create table if not exists public.whatsapp_link_codes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  tenant_id   uuid not null,
  code_hash   text not null unique,
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid,
  revoked_at  timestamptz,
  foreign key (org_id, tenant_id) references public.tenants (org_id, id) on delete restrict
);
create index if not exists whatsapp_link_codes_tenant_idx on public.whatsapp_link_codes (org_id, tenant_id);

create table if not exists public.whatsapp_conversations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  contact_id       uuid not null,
  state            text not null default 'idle',
  context          jsonb not null default '{}',
  state_at         timestamptz not null default now(),
  unknown_streak   int not null default 0,
  handoff_status   text not null default 'none' check (handoff_status in ('none', 'open', 'resolved')),
  handoff_reason   text check (char_length(handoff_reason) <= 300),
  handoff_at       timestamptz,
  handoff_resolved_by uuid references auth.users (id),
  updated_at       timestamptz not null default now(),
  unique (contact_id),
  foreign key (org_id, contact_id) references public.whatsapp_contacts (org_id, id) on delete restrict
);

-- The durable inbox. Webhook payloads are saved here BEFORE Meta is told "received". (kind, provider_id) is Meta's own id, so
-- redelivery of the same event is a no-op.
create table if not exists public.whatsapp_events (
  id             bigint generated always as identity primary key,
  org_id         uuid,
  phone_number_id text not null,
  kind           text not null check (kind in ('message', 'status')),
  provider_id    text not null check (char_length(provider_id) between 1 and 300),
  contact_key    text,                                           -- sender wa_id for messages (per-contact ordering); null for statuses
  payload        jsonb not null,
  status         text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'dead', 'ignored')),
  attempts       int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_by      text,
  locked_until   timestamptz,
  last_error     text check (char_length(last_error) <= 500),
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  unique (kind, provider_id)
);
create index if not exists whatsapp_events_work_idx on public.whatsapp_events (status, next_attempt_at, id) where status in ('pending', 'failed', 'processing');
create index if not exists whatsapp_events_contact_idx on public.whatsapp_events (contact_key, id) where status in ('pending', 'failed', 'processing');

create table if not exists public.whatsapp_messages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  contact_id          uuid not null,
  direction           text not null check (direction in ('in', 'out')),
  kind                text not null check (kind in ('text', 'template', 'unsupported')),
  body                text check (char_length(body) <= 4096),
  template            jsonb,                                      -- {name, lang, params[]}
  origin              text not null default 'bot' check (origin in ('contact', 'bot', 'staff', 'approval', 'system')),
  status              text not null check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'dead', 'blocked')),
  provider_message_id text,
  dedupe_key          text,
  error_code          text check (char_length(error_code) <= 40),
  error               text check (char_length(error) <= 500),
  attempts            int not null default 0,
  next_attempt_at     timestamptz not null default now(),
  locked_by           text,
  locked_until        timestamptz,
  approval_id         uuid,
  created_by          uuid references auth.users (id),
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  foreign key (org_id, contact_id) references public.whatsapp_contacts (org_id, id) on delete restrict,
  check ((direction = 'in') = (status = 'received'))
);
create unique index if not exists whatsapp_messages_provider_idx on public.whatsapp_messages (direction, provider_message_id) where provider_message_id is not null;
create unique index if not exists whatsapp_messages_dedupe_idx on public.whatsapp_messages (org_id, dedupe_key) where dedupe_key is not null;
create index if not exists whatsapp_messages_contact_idx on public.whatsapp_messages (contact_id, created_at desc);
create index if not exists whatsapp_messages_queue_idx on public.whatsapp_messages (next_attempt_at, id) where status in ('queued', 'sending');

-- Ties a maintenance request to the chat that raised it, so status updates go back to the right person and only they can ask about it.
create table if not exists public.whatsapp_request_links (
  request_id       uuid primary key references public.maintenance_requests (id) on delete restrict,
  org_id           uuid not null,
  contact_id       uuid not null,
  source_message_id text unique,
  last_status_sent text,
  created_at       timestamptz not null default now(),
  foreign key (org_id, contact_id) references public.whatsapp_contacts (org_id, id) on delete restrict
);
create index if not exists whatsapp_request_links_contact_idx on public.whatsapp_request_links (contact_id);

-- ------------------------------------------------------------- access
-- No table is writable by signed-in users; every change goes through a checked function. Message content is for managers and above.
revoke all on public.whatsapp_channels, public.whatsapp_faqs, public.whatsapp_contacts, public.whatsapp_link_codes, public.whatsapp_conversations,
  public.whatsapp_events, public.whatsapp_messages, public.whatsapp_request_links from anon, authenticated;
grant select on public.whatsapp_channels, public.whatsapp_faqs, public.whatsapp_contacts, public.whatsapp_conversations, public.whatsapp_messages to authenticated;
do $$ declare t text; begin
  foreach t in array array['whatsapp_channels', 'whatsapp_faqs', 'whatsapp_contacts', 'whatsapp_link_codes', 'whatsapp_conversations', 'whatsapp_events', 'whatsapp_messages', 'whatsapp_request_links'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
drop policy if exists whatsapp_channels_select on public.whatsapp_channels;
create policy whatsapp_channels_select on public.whatsapp_channels for select to authenticated using (app.has_role(org_id, 'admin'));
drop policy if exists whatsapp_faqs_select on public.whatsapp_faqs;
create policy whatsapp_faqs_select on public.whatsapp_faqs for select to authenticated using (app.has_role(org_id, 'manager'));
drop policy if exists whatsapp_contacts_select on public.whatsapp_contacts;
create policy whatsapp_contacts_select on public.whatsapp_contacts for select to authenticated using (app.has_role(org_id, 'manager'));
drop policy if exists whatsapp_conversations_select on public.whatsapp_conversations;
create policy whatsapp_conversations_select on public.whatsapp_conversations for select to authenticated using (app.has_role(org_id, 'manager'));
drop policy if exists whatsapp_messages_select on public.whatsapp_messages;
create policy whatsapp_messages_select on public.whatsapp_messages for select to authenticated using (app.has_role(org_id, 'manager'));

-- event types for in-app/email alerts to staff
insert into public.notification_event_types (event_type, label, default_email, default_in_app, mandatory) values
  ('whatsapp.handoff', 'WhatsApp conversation needs a person', true, true, false),
  ('whatsapp.urgent', 'Urgent WhatsApp message', true, true, true),
  ('whatsapp.delivery_failed', 'WhatsApp message could not be delivered', false, true, false)
on conflict (event_type) do nothing;

-- approval actions (executed by app.exec_copilot-style executors in the functions migration)
insert into public.approval_actions (action_type, label, description, request_min_role, approve_min_role) values
  ('copilot.send_whatsapp_reminder', 'Send a rent reminder on WhatsApp', 'Sends an approved rent-reminder template to a verified, opted-in tenant on WhatsApp.', 'manager', 'manager')
on conflict (action_type) do nothing;
