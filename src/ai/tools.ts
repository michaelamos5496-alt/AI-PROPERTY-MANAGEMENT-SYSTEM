import { z, type ZodTypeAny } from 'zod';
import { hasRole, type Role } from '../lib/roles.js';
import type { DataApi, ServiceApi } from '../services/supabase.js';
import type { Ref, ToolSpec } from './types.js';

/**
 * The only things the model can ask for. Each tool is a narrow, typed door: validated input, a minimum role, a stated side-effect class,
 * a timeout, and an approval policy. The model may REQUEST a call; the application decides whether it is allowed and what happens.
 * There is deliberately no tool for SQL, shell commands, file access, arbitrary URLs, or for approving anything.
 */
export type Kind = 'read' | 'controlled' | 'approval_required';
export type Policy = 'none' | 'user_confirmation' | 'human_approval';

export interface ToolContext {
  orgId: string; userId: string; role: Role; token: string; conversationId: string;
  data: DataApi; service: ServiceApi;
  /** Both the deployment switch and the organization's own setting. */
  externalEnabled: boolean;
}
export interface ToolOutput { result: Record<string, unknown>; refs?: Ref[]; actionId?: string }

export interface Tool<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  kind: Kind;
  policy: Policy;
  minRole: Role;
  timeoutMs: number;
  schema: S;
  /** What the audit trail must record for this call (always at least who, what, when, and the validated arguments). */
  audit: 'call' | 'call+proposal';
  available?: (ctx: Pick<ToolContext, 'externalEnabled'>) => boolean;
  run(ctx: ToolContext, args: z.infer<S>): Promise<ToolOutput>;
}

const uuid = z.string().uuid();

const refsOf = (r: any): Ref[] => (Array.isArray(r?.record_refs) ? r.record_refs : []);
const read = <S extends ZodTypeAny>(name: string, description: string, schema: S, fn: string, args: (a: z.infer<S>) => Record<string, unknown>, timeoutMs = 8000): Tool<S> => ({
  name, description, kind: 'read', policy: 'none', minRole: 'staff', timeoutMs, schema, audit: 'call',
  async run(ctx, a) { const r = await ctx.data.rpc<any>(ctx.token, fn, { p_org: ctx.orgId, ...args(a) }); return { result: r, refs: refsOf(r) }; },
});
const propose = <S extends ZodTypeAny>(name: string, description: string, kind: Kind, policy: Policy, schema: S, actionKind: string, extra: Partial<Tool<S>> = {}): Tool<S> => ({
  name, description, kind, policy, minRole: 'staff', timeoutMs: 8000, schema, audit: 'call+proposal', ...extra,
  async run(ctx, a) {
    // The server, not the model, names the acting user. Authorization is re-checked inside the database.
    const r = await ctx.service.rpc<any>('copilot_svc_propose_action', { p_org: ctx.orgId, p_user: ctx.userId, p_conversation: ctx.conversationId, p_kind: actionKind, p_payload: a });
    const needs = r.policy === 'human_approval' ? 'A manager must approve it before anything happens; the person you are helping presses "Request approval" first.'
      : r.policy === 'user_confirmation' ? 'It has NOT been done yet. The person you are helping must press Confirm.' : 'This is a draft only. Nothing has been sent.';
    return { result: { proposal_id: r.id, status: r.status, policy: r.policy, preview: r.preview, duplicate: r.duplicate, next_step: needs }, actionId: r.id };
  },
});

export const TOOLS: Tool[] = [
  read('get_portfolio_summary', 'Counts of properties, units (occupied/vacant), active tenancies, unresolved maintenance and pending approvals right now.', z.object({}).strict(), 'copilot_portfolio_summary', () => ({})),
  read('get_overdue_rent', 'Tenancies with overdue rent, largest first, with exact amounts per currency, days overdue, and the ids of the overdue charges. Optionally limit to one property or a minimum number of days overdue.',
    z.object({ property_id: uuid.optional(), min_days_overdue: z.number().int().min(0).max(3650).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    'copilot_overdue_rent', (a) => ({ p_property: a.property_id ?? null, p_min_days: a.min_days_overdue ?? 1, p_limit: a.limit ?? 25 })),
  read('find_tenants', 'Search tenants by name or email. Use this to get a tenant id; never guess ids.', z.object({ query: z.string().trim().min(2).max(80), limit: z.number().int().min(1).max(10).optional() }).strict(),
    'copilot_find_tenants', (a) => ({ p_query: a.query, p_limit: a.limit ?? 5 })),
  read('get_tenant_record', 'One tenant: contact details, tenancies, balances per currency, and open maintenance requests. Needs a tenant id from find_tenants or another tool result.',
    z.object({ tenant_id: uuid }).strict(), 'copilot_tenant_record', (a) => ({ p_tenant: a.tenant_id })),
  read('get_maintenance_requests', 'Maintenance requests, with counts by status. Defaults to unresolved ones. Can filter by status, property, or critical only.',
    z.object({ status: z.enum(['submitted', 'triaged', 'awaiting_approval', 'assigned', 'in_progress', 'resolved', 'cancelled']).optional(), property_id: uuid.optional(), critical_only: z.boolean().optional(), unresolved_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    'copilot_maintenance_requests', (a) => ({ p_status: a.status ?? null, p_property: a.property_id ?? null, p_critical_only: a.critical_only ?? false, p_unresolved: a.unresolved_only ?? true, p_limit: a.limit ?? 25 })),
  read('get_lease_expiries', 'Active tenancies whose end date falls within the next N days (default 60).', z.object({ within_days: z.number().int().min(1).max(365).optional(), property_id: uuid.optional() }).strict(),
    'copilot_lease_expiries', (a) => ({ p_within_days: a.within_days ?? 60, p_property: a.property_id ?? null })),
  read('get_rent_collection_summary', 'Billed, collected and outstanding rent per property and currency for a period (default: this month to date), with the basis of each figure. Use for questions about income.',
    z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), property_id: uuid.optional() }).strict(),
    'copilot_rent_collection_summary', (a) => ({ p_from: a.from ?? null, p_to: a.to ?? null, p_property: a.property_id ?? null }), 12000),

  propose('create_maintenance_request', 'Prepare a maintenance request for the user to confirm. It is not created until they press Confirm.', 'controlled', 'user_confirmation',
    z.object({ property_id: uuid, unit_id: uuid.optional(), title: z.string().trim().min(3).max(160), description: z.string().trim().min(1).max(4000),
      category: z.enum(['plumbing', 'electrical', 'heating_cooling', 'appliances', 'structural', 'pest', 'grounds', 'cleaning', 'security', 'other']).optional() }).strict(), 'create_maintenance_request'),
  propose('draft_rent_reminder', 'Write a rent-reminder draft for one overdue charge. The wording is produced by the system from the ledger; you only choose the charge. Nothing is sent.', 'controlled', 'none',
    z.object({ charge_id: uuid }).strict(), 'rent_reminder_draft'),
  propose('prepare_tenant_message', 'Draft a message to one tenant for a person to review. Nothing is sent. Do not include anything the tenant has not been told by staff.', 'controlled', 'none',
    z.object({ tenant_id: uuid, subject: z.string().trim().min(3).max(200), body: z.string().trim().min(3).max(3000) }).strict(), 'tenant_message_draft'),
  propose('create_approval_request', 'Prepare a consequential action that needs a manager. Supported: "test_action" (harmless; records a note) and "void_charge" (cancels a charge that was billed in error). Nothing happens until a person requests approval and a manager approves.', 'controlled', 'human_approval',
    z.discriminatedUnion('action', [
      z.object({ action: z.literal('test_action'), note: z.string().trim().min(3).max(500) }).strict(),
      z.object({ action: z.literal('void_charge'), charge_id: uuid, reason: z.string().trim().min(3).max(500) }).strict(),
    ]), 'dynamic'),
  propose('send_rent_reminder', 'Ask to email an EXISTING rent-reminder draft to the tenant. Needs the draft id from draft_rent_reminder and a manager\'s approval; the text sent is the draft\'s text.', 'approval_required', 'human_approval',
    z.object({ draft_id: uuid }).strict(), 'send_rent_reminder', { available: (c) => c.externalEnabled }),
  propose('send_tenant_message', 'Ask to email an EXISTING tenant-message draft. Needs the draft id from prepare_tenant_message and a manager\'s approval; the text sent is the draft\'s text.', 'approval_required', 'human_approval',
    z.object({ draft_id: uuid }).strict(), 'send_tenant_message', { available: (c) => c.externalEnabled }),
];

// create_approval_request fans out to two action kinds; wire that up here so the factory stays simple.
const approvalTool = TOOLS.find((t) => t.name === 'create_approval_request')!;
approvalTool.run = async (ctx, a: any) => {
  const [kind, payload] = a.action === 'test_action' ? ['test_action', { note: a.note }] : ['void_charge', { charge_id: a.charge_id, reason: a.reason }];
  const r = await ctx.service.rpc<any>('copilot_svc_propose_action', { p_org: ctx.orgId, p_user: ctx.userId, p_conversation: ctx.conversationId, p_kind: kind, p_payload: payload });
  return { result: { proposal_id: r.id, status: r.status, policy: r.policy, preview: r.preview, duplicate: r.duplicate, next_step: 'A manager must approve it before anything happens; the person you are helping presses "Request approval" first.' }, actionId: r.id };
};

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools this caller may even be told about. (The call itself is checked again at execution.) */
export function toolsFor(ctx: Pick<ToolContext, 'role' | 'externalEnabled'>): Tool[] {
  return TOOLS.filter((t) => hasRole(ctx.role, t.minRole) && (t.available ? t.available(ctx) : true));
}

/** Minimal JSON Schema for each tool, generated from the same zod schema that validates the call. */
export function specOf(t: Tool): ToolSpec {
  return { name: t.name, description: t.description, inputSchema: zodToJson(t.schema) };
}

function zodToJson(s: ZodTypeAny): Record<string, unknown> {
  const def: any = s._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      const required = Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([k]) => k);
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, zodToJson(v)])), ...(required.length ? { required } : {}), additionalProperties: false };
    }
    case 'ZodOptional': return zodToJson(def.innerType);
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const c of def.checks ?? []) { if (c.kind === 'uuid') out.format = 'uuid'; if (c.kind === 'min') out.minLength = c.value; if (c.kind === 'max') out.maxLength = c.value; if (c.kind === 'regex') out.pattern = c.regex.source; }
      return out;
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: def.checks?.some((c: any) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of def.checks ?? []) { if (c.kind === 'min') out.minimum = c.value; if (c.kind === 'max') out.maximum = c.value; }
      return out;
    }
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodEnum': return { type: 'string', enum: def.values };
    case 'ZodLiteral': return { type: 'string', enum: [def.value] };
    case 'ZodDiscriminatedUnion': {
      // Providers want one flat object at the top level; the strict zod union still decides what is actually accepted.
      const opts = [...def.options.values()].map((o: ZodTypeAny) => zodToJson(o) as { properties: Record<string, any> });
      const props: Record<string, any> = {};
      for (const o of opts) for (const [k, v] of Object.entries(o.properties)) props[k] = k === def.discriminator ? { type: 'string', enum: [...(props[k]?.enum ?? []), ...v.enum] } : v;
      return { type: 'object', properties: props, required: [def.discriminator], additionalProperties: false };
    }
    default: return {};
  }
}
