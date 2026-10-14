# Countries, currencies, time zones and phone numbers (Phase 7)

Reference data is configuration, never law.

* **Currencies** (`currencies`): ISO 4217 code, name, minor-unit exponent. GHS, NGN and KES have two decimals. A property's currency must be in this table (new/changed values only). SQL `app.money_text`, the TypeScript `src/lib/currency.ts` and the table are compared in a test so AI answers, WhatsApp text, exports and the database always agree.
  Money is stored as integer minor units with its currency; currencies are never added together (unchanged from Phase 3).
* **Countries** (`country_profiles`): ISO 3166 code, calling code, default currency/time zone/locale/date format, communication defaults. Seeded: GH, NG, KE, ZA, US (reference data only).
* **Organization settings** (`org_settings`, Plan → Country and currency; admins): country, currency, IANA time zone (validated), locale, date format, payment methods the organization uses (names only; no collection integration), communication preferences (channels, quiet hours, languages).
  Unset fields fall back to the country defaults.
* **Time zones:** a property keeps its own IANA time zone, which drives due dates, overdue status, rent reminders and "today" in jobs (existing behaviour, tested here for Africa/Accra, Lagos, Nairobi). The organization zone is the default for new properties, organization-wide "today" (AI answers), quiet hours and how timestamps are shown in the UI.
* **Locale and dates in the UI** follow the organization's locale/time zone (`setMarket` in `web/js/kit.js`); amounts are always shown with their currency.
* **Phone numbers** are stored as E.164 (`+233241234567`), read against the organization's country; a number written with `+` is international; invalid numbers are refused; with no country set a national number is refused as ambiguous (libphonenumber-js).
* **Quiet hours** hold back proactive WhatsApp messages (status updates, approved reminders) until they end, in the organization's time zone. Replies to a person and staff messages are never delayed. Email jobs do not yet honour quiet hours.
* **Payment providers:** the registry lists names and kinds (`manual_bank_transfer`, `manual_cash`, `manual_mobile_money` enabled; `paystack`, `flutterwave` planned). No provider is assumed to support any currency. Rent collection through a gateway is not built; payments are recorded manually.

## Country-specific legal and tenancy rules: not included, by design

Nothing country-specific that could be a legal obligation is built in (notice periods, deposit rules, eviction procedure, rent-increase limits, tax). The **extension point** is `country_rule_packs`:

* A pack is `draft` → `under_review` → `reviewed` (→ `retired`). `reviewed` requires a **named reviewer, a timestamp and a written note** (database constraint).
* An organization can enable a pack only if it is `reviewed` **and** belongs to the organization's country (`save_market` refuses otherwise). `app.rule_pack(org, code)` returns the content only when both hold; a future workflow must ask it rather than assume.
* Registering and reviewing are operator-only (`rules_svc_register`, `rules_svc_review`).
* **No pack ships.** Before introducing any jurisdiction-specific legal or tenancy workflow, have a qualified local professional review the rules and record that review on the pack.
