-- Phase 5: AI copilot persistence. The model never touches the database: the server does, as the signed-in user for reads,
-- and through service-only functions for the audit trail it must be able to trust.

insert into public.notification_event_types (event_type, label, default_email, default_in_app, mandatory) values
  ('tenant.message', 'Message to a tenant', true, false, false)
on conflict (event_type) do nothing;

create table if not exists public.copilot_settings (
  org_id                    uuid primary key references public.organizations (id) on delete restrict,
  enabled                   boolean not null default true,
  external_enabled          boolean not null default false,       -- messages to tenants stay OFF until an admin turns them on
  daily_budget_micro        bigint not null default 5000000 check (daily_budget_micro between 0 and 1000000000000),   -- micro-USD (1e-6)
  max_turns_per_user_hour   int not null default 60 check (max_turns_per_user_hour between 1 and 1000),
  updated_by                uuid references auth.users (id),
  updated_at                timestamptz not null default now()
);

create table if not exists public.copilot_conversations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete restrict,
  user_id          uuid not null references auth.users (id),
  title            text not null default 'New conversation' check (char_length(title) between 1 and 120),
  status           text not null default 'active' check (status in ('active', 'archived')),
  running_since    timestamptz,                          -- a turn is in flight (lease; stale after 2 minutes)
  cancel_requested boolean not null default false,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz,
  unique (org_id, id)
);
create index if not exists copilot_conversations_user_idx on public.copilot_conversations (org_id, user_id, last_message_at desc nulls last);

create table if not exists public.copilot_messages (
  id              bigint generated always as identity primary key,
  org_id          uuid not null,
  conversation_id uuid not null,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) <= 12000),
  blocks          jsonb,                                  -- assistant only: validated answer facts, result cards, record refs, warnings
  request_id      text,
  model           text,
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  cost_micro      bigint not null default 0,
  status          text not null default 'ok' check (status in ('ok', 'error', 'cancelled', 'timeout', 'refused', 'fallback', 'limit')),
  created_at      timestamptz not null default now(),
  foreign key (org_id, conversation_id) references public.copilot_conversations (org_id, id) on delete restrict
);
create index if not exists copilot_messages_conv_idx on public.copilot_messages (conversation_id, id);

-- One row per tool call the model asked for, including the ones we refused. Written only by the server.
create table if not exists public.copilot_tool_calls (
  id              bigint generated always as identity primary key,
  org_id          uuid not null,
  conversation_id uuid not null,
  user_id         uuid not null references auth.users (id),
  request_id      text,
  call_id         text,
  tool            text not null check (char_length(tool) <= 80),
  kind            text check (kind in ('read', 'controlled', 'approval_required', 'unknown')),
  args            jsonb,
  status          text not null check (status in ('ok', 'denied', 'invalid_args', 'unknown_tool', 'forbidden', 'error', 'timeout', 'duplicate', 'duplicate_blocked', 'limit')),
  error           text check (char_length(error) <= 500),
  duration_ms     int not null default 0,
  result_bytes    int not null default 0,
  result_hash     text,
  action_id       uuid,
  created_at      timestamptz not null default now(),
  foreign key (org_id, conversation_id) references public.copilot_conversations (org_id, id) on delete restrict
);
create index if not exists copilot_tool_calls_conv_idx on public.copilot_tool_calls (conversation_id, id);
create index if not exists copilot_tool_calls_org_idx on public.copilot_tool_calls (org_id, created_at desc);

-- A proposed action. The payload is immutable; a different payload is a different action.
create table if not exists public.copilot_actions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete restrict,
  conversation_id uuid,
  user_id         uuid not null references auth.users (id),
  kind            text not null check (kind in ('create_maintenance_request', 'rent_reminder_draft', 'tenant_message_draft', 'send_rent_reminder', 'send_tenant_message', 'void_charge', 'test_action')),
  policy          text not null check (policy in ('none', 'user_confirmation', 'human_approval')),
  status          text not null default 'proposed' check (status in ('draft', 'proposed', 'submitted', 'executed', 'cancelled', 'failed', 'expired')),
  payload         jsonb not null,
  payload_hash    text not null,
  preview         jsonb not null,
  approval_id     uuid,
  result          jsonb,
  error           text check (char_length(error) <= 500),
  expires_at      timestamptz not null default now() + interval '24 hours',
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  foreign key (org_id, conversation_id) references public.copilot_conversations (org_id, id) on delete restrict,
  foreign key (org_id, approval_id) references public.approvals (org_id, id) on delete restrict,
  unique (org_id, id),
  check ((policy = 'none') = (kind in ('rent_reminder_draft', 'tenant_message_draft'))),
  check (status <> 'draft' or policy = 'none')
);
create index if not exists copilot_actions_user_idx on public.copilot_actions (org_id, user_id, created_at desc);
create index if not exists copilot_actions_conv_idx on public.copilot_actions (conversation_id);

create table if not exists public.copilot_usage (
  org_id        uuid not null references public.organizations (id) on delete restrict,
  day           date not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_micro    bigint not null default 0,
  turns         int not null default 0,
  primary key (org_id, day)
);

-- Non-destructive demonstration target for the approval lifecycle: executing it only writes this row.
create table if not exists public.copilot_test_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  action_id   uuid not null,
  note        text not null,
  approved_by uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  foreign key (org_id, action_id) references public.copilot_actions (org_id, id) on delete restrict
);

-- ---------------------------------------------------------------- guards
do $$
declare r record;
begin
  for r in select * from (values
    ('copilot_messages', array[]::text[]), ('copilot_tool_calls', array[]::text[]), ('copilot_test_log', array[]::text[])) v(t, cols)
  loop
    execute format('drop trigger if exists %I_guard on public.%I', r.t, r.t);
    execute format('create trigger %I_guard before update or delete on public.%I for each row execute function app.finance_guard(%s)', r.t, r.t,
      coalesce((select string_agg(quote_literal(c), ',') from unnest(r.cols) c), ''));
  end loop;
end $$;
drop trigger if exists copilot_actions_guard on public.copilot_actions;
create trigger copilot_actions_guard before update or delete on public.copilot_actions
  for each row execute function app.finance_guard('status', 'approval_id', 'result', 'error', 'resolved_at');

-- ------------------------------------------------------------- access
revoke all on public.copilot_settings, public.copilot_conversations, public.copilot_messages, public.copilot_tool_calls, public.copilot_actions,
  public.copilot_usage, public.copilot_test_log from anon, authenticated;
grant select on public.copilot_settings, public.copilot_conversations, public.copilot_messages, public.copilot_tool_calls, public.copilot_actions, public.copilot_usage to authenticated;

alter table public.copilot_settings enable row level security;
drop policy if exists copilot_settings_select on public.copilot_settings;
create policy copilot_settings_select on public.copilot_settings for select to authenticated using (app.has_role(org_id, 'staff'));
-- A conversation, its messages and its proposed actions are private to the person who had it.
alter table public.copilot_conversations enable row level security;
drop policy if exists copilot_conversations_select on public.copilot_conversations;
create policy copilot_conversations_select on public.copilot_conversations for select to authenticated using (user_id = (select auth.uid()) and app.has_role(org_id, 'staff'));
alter table public.copilot_messages enable row level security;
drop policy if exists copilot_messages_select on public.copilot_messages;
create policy copilot_messages_select on public.copilot_messages for select to authenticated
  using (exists (select 1 from public.copilot_conversations c where c.id = conversation_id and c.user_id = (select auth.uid()) and app.has_role(c.org_id, 'staff')));
alter table public.copilot_actions enable row level security;
drop policy if exists copilot_actions_select on public.copilot_actions;
create policy copilot_actions_select on public.copilot_actions for select to authenticated using ((user_id = (select auth.uid()) and app.has_role(org_id, 'staff')) or app.has_role(org_id, 'manager'));
-- The audit trail of tool use is visible to the user it concerns and to managers.
alter table public.copilot_tool_calls enable row level security;
drop policy if exists copilot_tool_calls_select on public.copilot_tool_calls;
create policy copilot_tool_calls_select on public.copilot_tool_calls for select to authenticated using ((user_id = (select auth.uid()) and app.has_role(org_id, 'staff')) or app.has_role(org_id, 'manager'));
alter table public.copilot_usage enable row level security;
drop policy if exists copilot_usage_select on public.copilot_usage;
create policy copilot_usage_select on public.copilot_usage for select to authenticated using (app.has_role(org_id, 'manager'));
alter table public.copilot_test_log enable row level security;

-- ---------------------------------------------------- approval actions
insert into public.approval_actions (action_type, label, description, request_min_role, approve_min_role) values
  ('copilot.test_action',        'AI test action',          'A harmless test that only records a note. Used to try the approval process safely.', 'staff', 'manager'),
  ('copilot.send_rent_reminder', 'Send a rent reminder',    'Emails an overdue-rent reminder to a tenant, with the exact text shown.',            'staff', 'manager'),
  ('copilot.send_tenant_message','Send a message to a tenant', 'Emails a message to a tenant, with the exact text shown.',                        'staff', 'manager')
on conflict (action_type) do nothing;
