# AI copilot (Phase 5)

A panel at **Copilot** in the workspace (staff and above). It answers questions from the organization's current records and *prepares*
work. It never sends, approves, pays, voids or changes anything by itself.

## The rule that everything else follows

> The model may **request** a tool call. The application, then the database, decide whether it is allowed and what happens.

* Credentials are server-side only (`ANTHROPIC_API_KEY`); the browser never sees a key, and the bundle scan fails the build if one leaks.
* Every tool call is validated independently (strict zod schema), authorized (role), executed with a timeout, and written to an
  append-only audit table, including refused calls (unknown tool, invalid arguments, denied, forbidden, duplicate, limit).
* Reads run **as the signed-in user** through the same SECURITY DEFINER functions and role checks as the rest of the app, so the model
  can never see more than the person asking. Cross-organization ids, hallucinated ids and other people's records return "not found".
* Writes go through service-only functions that take the acting user from the **server**, never from model output. Signed-in users
  cannot call them (proved in tests), so the audit trail and proposals cannot be forged from a browser.

## Tools

| Tool | Class | Policy |
|---|---|---|
| get_portfolio_summary, get_overdue_rent, find_tenants, get_tenant_record, get_maintenance_requests, get_lease_expiries, get_rent_collection_summary | read | none |
| create_maintenance_request | controlled | user confirmation (button) |
| draft_rent_reminder, prepare_tenant_message | controlled | none: a draft, nothing is sent |
| create_approval_request (`test_action`, `void_charge`) | controlled | human approval |
| send_rent_reminder, send_tenant_message | approval-required | human approval; only offered when **both** external switches are on |

There is no tool for SQL, shell, files, arbitrary URLs, or for approving/deciding anything. A tool that does not exist cannot be called:
a hallucinated tool name is refused and logged.

## Approval lifecycle

`model proposes` → card shows the exact preview → **person presses Request approval** → a different, senior person approves in the normal
Approvals inbox → the engine re-checks permissions and that nothing changed → executes once → result is shown on the card and in the audit log.

* The stored proposal's payload is immutable and hashed. The generic approval endpoint cannot be used to submit a different payload for it,
  and an approval for one payload cannot be reused for another.
* **Message text is fixed in the draft the user saw.** `send_*` takes only a draft id; the text comes from the stored draft, never from
  the model at send time.
* A send is withdrawn if the charge is settled/voided, the tenant opts out or is archived, or external messaging is switched off in between.
* Try it safely first: *Copilot → "Try the approval process safely"* creates a harmless `test_action` that only writes a note to
  `copilot_test_log` when approved. External email stays off until both switches are turned on deliberately.

## External communications: double gate, off by default

1. Deployment: `COPILOT_EXTERNAL_ENABLED=true`.
2. Organization: an admin ticks "Allow it to prepare emails to tenants" in Copilot → Settings (audited).

Until both are on, `send_*` tools are not even offered to the model and the database refuses to create the proposal.

## Prompt injection

Tenant messages, maintenance descriptions, names and notes are untrusted. Tool results are wrapped in `<untrusted_data>` (the delimiter is
defanged inside the data), the system prompt says such text is data, and results are scanned for instruction-like text; matches are
flagged to the user and recorded. This is defence in depth, **not** the control: the real controls are that nothing the model reads can
raise permissions, that approvals need a different human, and that outgoing text is pinned to a draft a person read.

## Grounding

Answers carry: "as of" date, reporting period, currency, and the basis of each calculation (from the tool result). Currencies are never
combined. The server adds `*_display` amounts so the model never does money arithmetic, attaches record links from the tools used, and
checks the final text: money figures and record ids that no tool returned this turn are shown to the reader as **unverified**.

## Limits

Per turn: 6 model steps, 12 tool calls, 4 calls per step, 20 KB per tool result, 6000 characters of answer, 50 s deadline, 30 s per model
call. Per user: 20 messages/hour (setting), one running turn per conversation (DB lease), 2 running conversations. Per organization: a
daily budget (default $5, setting) from recorded token usage at the prices you configure. Per instance: 8 concurrent turns. Repeated
identical tool calls are answered from the first result, then blocked. Stop button cancels a running turn.

## Failure behaviour

Model timeout/outage/rejection, budget exhausted, deadline or cancellation produce a clearly marked fallback message ("not answered by
the AI"), release the conversation, and change nothing. With `LLM_PROVIDER=offline` the same tools run through a fixed rules engine.

## Configuration

See `.env.example` (section "AI copilot"). Required for the real model: `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` (used for the audit/proposal functions). Set `LLM_*_MICRO_PER_MTOK` to your actual prices so the budget is true.

## Not covered / limits

* Not tested against the live Anthropic API, live Supabase, or real email delivery (the adapter is tested against a fake client).
* Injection detection is heuristic. Documents uploaded to storage are not read by the copilot in this phase.
* Per-instance limits (concurrency, request rate) are in memory; the database enforces the cross-instance ones.
* Tenant-facing chat is out of scope; this is a staff tool.
