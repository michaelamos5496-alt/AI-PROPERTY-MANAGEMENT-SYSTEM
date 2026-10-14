export const ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const rank: Record<Role, number> = { owner: 4, admin: 3, manager: 2, staff: 1, viewer: 0 };

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
export const hasRole = (actual: Role, minimum: Role): boolean => rank[actual] >= rank[minimum];

/** Capability matrix. Keep in sync with the SQL functions; the database is the final authority. */
export const PERMISSIONS = {
  'org:read': 'viewer',
  'org:update': 'admin',
  'members:read': 'viewer',
  'members:manage': 'admin',
  'invitations:manage': 'admin',
  'properties:write': 'manager',   // properties, units, owners
  'tenants:write': 'staff',
  'tenancies:write': 'staff',      // create/edit drafts, manage tenants on a tenancy
  'tenancies:transition': 'manager', // activate, end, cancel; edit live terms
  'leases:write': 'staff',
  'documents:read': 'staff',
  'documents:write': 'staff',
  'records:archive': 'manager',
  'finance:read': 'staff',         // ledger, payments, balances, expenses, receipts
  'payments:write': 'staff',       // record payments, allocate, issue receipts
  'finance:manage': 'manager',     // schedules, charges, reversals, voids, expenses
  'finance:adjust': 'admin',       // charge adjustments (waivers / uplifts)
  'finance:audit': 'manager',      // audit history and reconciliation
  'maintenance:read': 'staff',
  'maintenance:write': 'staff',    // submit, triage, note, assign (staff: to themselves), estimate, progress
  'maintenance:manage': 'manager', // assign to anyone, cancel arranged work, reopen, acknowledge escalations, vendors, urgency levels
  'maintenance:settings': 'admin', // escalation contact, keywords, approval thresholds
  'copilot:use': 'staff',          // ask the AI copilot; it can only prepare work for a person to confirm or a manager to approve
  'copilot:manage': 'admin',       // turn the copilot and external messaging on or off, set the daily AI budget
  'whatsapp:use': 'manager',       // WhatsApp conversations, link codes, handoffs, replies, reminder drafts
  'whatsapp:manage': 'admin',      // connect the number, FAQs, templates
  'billing:manage': 'admin',       // see the plan and usage, start checkout, reconcile
  'market:manage': 'admin',        // country, currency, time zone, locale, regional communication settings
  'exports:use': 'staff',          // CSV exports (also needs the plan to include them)
  'approvals:request': 'staff',
  'approvals:decide': 'manager',
  'delivery:manage': 'manager',    // email queue visibility, retries, run scheduled jobs
  'portal:manage': 'manager',      // invite / revoke tenant portal access
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, permission: Permission): boolean => hasRole(role, PERMISSIONS[permission]);
