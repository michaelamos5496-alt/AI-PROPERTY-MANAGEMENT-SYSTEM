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
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, permission: Permission): boolean => hasRole(role, PERMISSIONS[permission]);
