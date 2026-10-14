# Phase 2 data model

All tables carry `org_id`; child tables reference parents with **composite `(org_id, id)` foreign keys**, so a record can
never point at another organization's parent (enforced by Postgres, not just application code).

```
organizations ─┬─ properties ──< units ──< tenancies ──< leases ──< lease_documents (bytes in private Storage)
               ├─ owners  >──< property_owners >──< properties      (many-to-many; owners need no account)
               └─ tenants >──< tenancy_tenants >──< tenancies        (co-tenants; exactly one primary)
```

| Table | Notable columns / constraints |
|---|---|
| `properties` | address, `country` (ISO-3166 alpha-2), `timezone` (IANA, validated), `currency` (ISO-4217), type enum, `version`, `archived_at` |
| `owners` | name, type (individual/company/trust/other), contact, optional `user_id` (reserved link to a platform user) |
| `property_owners` | `ownership_pct` (0–100, sum ≤ 100 enforced), one `is_primary` per property |
| `units` | `reference` unique per property among non-archived (case-insensitive), beds/baths/area, `market_rent_minor`, `is_available` |
| `tenants` | contact + emergency contact |
| `tenancies` | `status`, `start_date`, optional `end_date`, rent (minor units, period, due day), deposit amount + scheme, `currency` (copied from property), notice days |
| `leases` | `kind` (initial/renewal/amendment), dates, `signed_on` |
| `lease_documents` | name, type, mime, size ≤ 10 MB, `storage_path` (unique), `status` pending/available, `archived_at` |

**Occupancy** (`occupied | upcoming | vacant | unavailable`) is *derived*, never stored: it uses active tenancies and the
**property's local date** (`now() at time zone properties.timezone`), so a lease starting "today" flips at local midnight.

## Tenancy status machine

```
draft ──activate──> active ──end──> ended      (terminal)
  └────cancel─────> cancelled                  (terminal)
```
* `activate`: needs a primary tenant, non-archived unit/property, **no overlapping active tenancy on the unit**
  (checked under a row lock on the unit so concurrent activations serialize).
* `end`: end date must be ≥ start and ≤ today (property tz). A future end is set by editing an active tenancy's `end_date`.
* A trigger rejects any other status change, even from raw SQL. `org_id`, `unit_id`, etc. are immutable (trigger).
* Active tenancies cannot change `start_date`; ended/cancelled tenancies are read-only.

## Permissions (database is authoritative; API mirrors it in `src/lib/roles.ts`)

| Action | Minimum role |
|---|---|
| Read properties, units, owners, tenants, tenancies, leases | viewer |
| Create/edit tenants, draft tenancies, leases; manage tenants on a tenancy; upload documents; read/download documents | staff |
| Create/edit properties, units, owners; activate / end / cancel; edit live tenancy terms; archive/restore any record | manager |

Non-members always get **404** (never 403) so IDs cannot be probed.

## History is never destroyed
* No hard-delete path exists. Every parent→child FK is `ON DELETE RESTRICT` (including organizations).
* "Delete" = **archive** (`archived_at`). Archiving is refused while open (draft/active) tenancies exist.
  Archived records leave default lists (`?archived=true` shows them) and stay fully readable from tenancy history.
* A property's currency is locked once any tenancy exists.

## Concurrent edits
Every editable record has `version`. Updates send `expectedVersion`; a mismatch returns **409** ("changed by someone
else") and nothing is overwritten. Status transitions also check the version.

## Lease documents: private storage
1. `POST /leases/:id/documents` → `create_document` registers metadata (`pending`) and a path
   `org/lease/docId-sanitizedName`; the server returns a **one-time signed upload URL for exactly that path**.
2. Browser `PUT`s the bytes straight to Storage (bypasses Vercel's 4.5 MB body limit).
3. `POST /documents/:id/confirm` — the server reads the object's *real* size/type from Storage (as the user), then marks it `available`.
4. `GET /documents/:id/download` — role + org + record are checked in Postgres, then a **60-second signed URL** is minted.
   Every download is logged with user/org/document ids.

Bucket `lease-documents` is private, 10 MB, PDF/PNG/JPEG/DOCX only. `storage.objects` policies derive access from the
`lease_documents` row that owns the path: insert only to a registered *pending* path (staff+), select only for
*available* documents (staff+, or the uploader for their own pending file). No update/delete policies: files are immutable.
