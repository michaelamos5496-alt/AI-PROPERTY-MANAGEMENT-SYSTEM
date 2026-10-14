# WhatsApp tenant assistant (Phase 6)

Tenants message your WhatsApp Business number. The assistant answers **organization-approved FAQs**, takes **maintenance reports**,
gives **reference numbers and status updates**, and hands anything urgent, sensitive or unclear to a **named person**. It is built on
the official Meta WhatsApp Business Platform **Cloud API**.

> **Status: built and tested against simulated Meta traffic. Not verified against Meta.** See "Verification log" at the end. Do not
> describe this as connected to production until a real message has gone phone → Meta → this app → Meta → phone.

## How a message travels

```
Meta ──POST (signed)──▶ /api/webhooks/whatsapp ── verify HMAC over the raw bytes ── save every event (durable inbox, unique on Meta's ids)
                                                   │ 200 only after saving (500 if saving fails, so Meta redelivers)
                                                   ▼
                       bounded inline processing (≈3 s) ──▶ workers (scheduler, every run) drain what is left, with retries
                                                   ▼
              conversation engine ──▶ replies are queued ──▶ send worker ──▶ Meta Cloud API ──▶ delivery receipts (webhook) update status
```

* **Verification (GET):** `hub.mode=subscribe` and `hub.verify_token` must equal `WHATSAPP_VERIFY_TOKEN`; the `hub.challenge` is echoed.
* **Signature (POST):** `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body with the app secret>`, compared in constant time over the
  exact bytes received. Anything else is `401` and is neither stored nor processed. With no app secret configured the endpoint refuses everything.
* **Idempotency:** events are unique on `(kind, Meta id)`; statuses on `(message id, status)`. Redelivery, duplicates and replays are no-ops;
  replies are deduplicated per (incoming message, position) so a retried event never answers twice; request creation is idempotent on the
  message id.
* **Ordering:** a contact's events are processed strictly in arrival order, one at a time; different contacts in parallel.
* **Retries:** a failing event is retried with backoff (6 attempts, then `dead`, visible in Setup). A crashed worker's lease expires and
  another takes over. Delivery receipts that beat our own bookkeeping are retried briefly.
* **Delayed events:** a message that reaches us after the 24-hour window cannot be answered with free text, so it becomes a **handoff** to a person rather than being lost.
* **Unsupported content** (images, audio, stickers…): a short "text only" reply. Reactions and system events are ignored.
* **Provider outage:** sends are retried with exponential backoff (up to 6 attempts); permanent errors (closed window, undeliverable,
  template errors) fail immediately and notify whoever requested the message. Nothing is silently dropped.
* **Webhook size:** 1 MB limit. PII retention: processed events are deleted after 30 days (`wa_svc_purge`); messages remain for audit.

## Identity: a phone number is not proof of anything

| Who is writing | May do | May never see |
|---|---|---|
| Unverified number | FAQs, report a problem (property and unit typed by them), ask the status of **requests created from that same chat**, ask for a person | balances, lease documents, tenant names or any tenant/financial data |
| Linked tenant (verified, < 180 days) | all of the above, plus their **own** balance and requests on their **own** active tenancies | another tenant's anything |
| Opted-out or blocked | nothing is sent to them; a safety message still alerts a person | — |

* **Linking:** a manager creates a **one-time code** for a specific tenant (needs an active tenancy; shown once; only its hash is stored; 8
  characters from an unambiguous alphabet; expires in 48 h; creating a new one revokes the old). The tenant sends `LINK <code>` from their
  phone. Unknown, expired, used, revoked, other-organization and archived-tenant codes all get the **same** reply. Five wrong guesses
  lock the number for an hour, even for a correct code. A verified number cannot be re-linked to a different tenant.
* **Never** matched on the phone number stored on the tenant record.
* **Mapping tables:** `whatsapp_contacts` (org + number → tenant, status, consent), `whatsapp_link_codes`, `whatsapp_request_links` (request ↔ contact),
  and tenancies are derived live from the tenant, so an ended tenancy loses access automatically. Verification lapses after 180 days (re-link).
* **Routing / tenant isolation:** the organization comes only from the **business phone number id** of the delivery (`whatsapp_channels.phone_number_id`, unique).
  The same person writing to two organizations is two unrelated contacts. A number can belong to only one organization. Every service
  function takes the organization from that lookup, never from message text.
* The assistant is **not an LLM**: it speaks to unauthenticated strangers, so wording is fixed, FAQs are yours, and data comes from the database.

## What it does

* **FAQs** (Setup → FAQs, admins): matched by keyword; no match → it offers a person instead of guessing.
* **Maintenance:** describe → (verified: their tenancy / unverified: property, then unit, both validated against your records, 3 tries) → "Reply YES" → request created with a **reference `MR-XXXXXXXX`**, tagged *WhatsApp*, attributed to the channel's intake manager, with a note saying whether the sender was verified. Safety keywords reuse the existing escalation rules.
* **Status updates:** `STATUS` / `STATUS MR-…`; progress changes are pushed once each (text inside the window, otherwise an approved template if the tenant opted in).
* **Urgent:** emergency wording → immediate alert to the designated person (or every admin) even before the report is complete; the sender is told to call emergency services if anyone is in danger.
* **Escalation:** requests for a person, legal/safety/complaint/dispute wording, or two messages in a row it cannot understand → handoff (the assistant stays quiet except for safety), shown in **WhatsApp → Conversations**; managers can reply (inside the window) and mark it handled.
* **Rent reminders:** a manager drafts from the ledger → **Request approval** → a *different* manager/admin approves in the normal inbox → the approved template is queued. Needs: verified number, tenant opted in, both external-messaging switches (`COPILOT_EXTERNAL_ENABLED` and the organization setting), channel on, template configured. Withdrawn automatically if the charge is settled, the tenant opts out or is unlinked before approval.

## Messaging rules

* **24-hour window:** free text only within 24 h of the contact's last message (enforced in the database at queue time *and again at send time*). Outside it only an approved **template**.
* **Templates** (create and get approved in Meta first): `rent_reminder_v1` (utility; body e.g. `Hello {{1}}, {{2}} is outstanding and was due on {{3}}.`) and `request_update_v1` (`Update on {{1}}: your request {{2}}.`). Names and wording are set in Setup; the wording you enter is only for previews — **Meta sends the approved text**.
* **Consent and opt-out:** templates need an explicit opt-in (after linking, the tenant is asked `YES`/`NO`; `UPDATES`/`START` also opt in). `STOP`, `UNSUBSCRIBE`, `QUIT`, `OPT OUT` stop everything at once (one acknowledgement is allowed); queued messages are cancelled; nothing is sent until `START`. If WhatsApp reports error `131050` (user stopped marketing messages) the contact is treated as opted out.
* **Rate limits:** inbound 20 / 10 min per number (one notice, then ignored); outbound automated 15 / 24 h per contact; send retries back off; daily caps on requests per number (3 unverified, 10 verified).
* **Delivery tracking:** sent → delivered → read, failed with Meta's error code; late, duplicate and out-of-order receipts never move a message backwards.

## Configuration

Server (`.env.example`, "WhatsApp"): `WHATSAPP_PROVIDER` (`log` = nothing is sent, default; `cloud`), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_GRAPH_VERSION` (default `v25.0`, taken from Meta's current docs examples; confirm it), plus `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` (workers).
Per organization (Setup, admins): phone number ID, business account ID, intake manager, urgent contact, templates, welcome text, on/off.
The scheduler (`/api/internal/jobs/run`, every 10 min on GitHub Actions) retries anything not finished inline; for snappier retries run it more often.

## Meta prerequisites (sandbox → production)

**Sandbox / test (you can do this today):**
1. A Meta developer account and a **Business** app with the **WhatsApp** product; a Meta Business portfolio.
2. The auto-created **test WhatsApp Business Account** and **test phone number**; note its **Phone number ID** (not the number) and WABA ID.
3. Add up to 5 **recipient numbers** (your own phones) and verify them with the code.
4. A **system user** access token with `whatsapp_business_messaging` (and `whatsapp_business_management` to manage templates). The temporary 24-hour token works for a first try.
5. **App secret** (App settings → Basic) → `WHATSAPP_APP_SECRET`.
6. Webhook: callback `https://<your-app>/api/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`; subscribe to the **messages** field on the WABA.
7. The test number can only message verified recipients and, outside a 24-hour window, only the `hello_world` template.

**Production adds:** Meta **business verification**; your own phone number registered to the WABA (not already on a personal WhatsApp account) with an approved **display name**; a payment method; approved message **templates** (utility category for the two above); a **privacy policy** URL and, for each tenant, an **opt-in record** for proactive messages (the link flow's `YES` is recorded with a timestamp); messaging-limit tier awareness (starts low and grows); data-processing terms with Meta; a long-lived system-user token (not the temporary one). Review Meta's current *WhatsApp Business Messaging Policy* and *Commerce/Business policies* before launch; policies change.

## Test workflow (Meta sandbox)

1. Deploy with `WHATSAPP_PROVIDER=cloud` and the secrets above; in the app: **WhatsApp → Setup → Connect a number**, enable it, create a FAQ.
2. `APP_URL=… WHATSAPP_VERIFY_TOKEN=… WHATSAPP_APP_SECRET=… WHATSAPP_PHONE_NUMBER_ID=… node scripts/whatsapp-sandbox-check.mjs --from <your sandbox recipient> --send-test`
   (handshake, wrong/missing signature → 401, signed message stored once, duplicate is a no-op, Graph API accepts a test message).
3. By hand from your phone: `help` → reply; `REPORT` flow → request appears in Maintenance tagged WhatsApp; create a link code and `LINK <code>` → `BALANCE`; `STOP` → silence; `START`.
4. Fill in the log below.

## Known limits

* The simulated tests prove our handling of Meta's documented payloads, not Meta itself; payload fields can change.
* English only. Text only (no media in or out). No interactive buttons/lists. No group chats.
* One Meta app/token for all organizations (each organization has its own number); per-customer tokens (embedded signup) are future work.
* Unverified senders can learn whether a property name or unit reference exists (needed to log a report). Rate limits and a 3-try cap apply; disable the channel or use FAQs only if that is unacceptable.
* Per-instance limits are in memory; the database enforces the cross-instance ones. Inline processing is best-effort on serverless (it may be cut short); the scheduler finishes the job.
* Sender numbers and message text are stored (messages: for audit, events: 30 days). Add a retention/erasure policy that matches your privacy notice.

## Verification log

| Date | Environment | What was seen | Message ids | By |
|---|---|---|---|---|
| — | **not yet verified end to end** | | | |
