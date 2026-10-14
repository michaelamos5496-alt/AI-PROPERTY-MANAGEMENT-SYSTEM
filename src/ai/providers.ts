import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../lib/env.js';
import { LlmError, type AssistantBlock, type LlmProvider, type LlmRequest, type LlmResponse, type Message } from './types.js';

/** Real model. The API key lives only in server configuration; this class is the only place that touches it. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(private env: Env, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: env.LLM_TIMEOUT_MS });
  }
  get model() { return this.env.LLM_MODEL; }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.client.messages.create({
        model: this.env.LLM_MODEL, max_tokens: req.maxTokens, system: req.system,
        messages: req.messages.map(toAnthropic),
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
        metadata: { user_id: req.requestId.slice(0, 64) },
      }, { signal: req.signal, timeout: this.env.LLM_TIMEOUT_MS });
      const content: AssistantBlock[] = [];
      for (const b of res.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
      const stop = res.stop_reason;
      return {
        content, model: res.model ?? this.env.LLM_MODEL,
        stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'end_turn' || stop === 'stop_sequence' ? 'end_turn' : stop === 'max_tokens' ? 'max_tokens' : (stop as string) === 'refusal' ? 'refusal' : 'other',
        usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      };
    } catch (e: any) {
      if (req.signal.aborted) {
        if ((req.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') throw new LlmError('The AI service took too long to answer.', 'timeout');
        throw new LlmError('The request was cancelled.', 'cancelled', false);
      }
      const status = Number(e?.status);
      if (e?.name === 'APIConnectionTimeoutError' || e?.name === 'TimeoutError') throw new LlmError('The AI service took too long to answer.', 'timeout');
      if (status === 400 || status === 401 || status === 403 || status === 404) throw new LlmError('The AI service rejected the request. An administrator should check the AI configuration.', 'rejected', false);
      throw new LlmError('The AI service is temporarily unavailable.', 'unavailable');
    }
  }
}

function toAnthropic(m: Message): Anthropic.MessageParam {
  if (m.role === 'assistant') return { role: 'assistant', content: m.content.map((b) => (b.type === 'text' ? { type: 'text' as const, text: b.text } : { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input as Record<string, unknown> })) };
  if (typeof m.content === 'string') return { role: 'user', content: m.content };
  return { role: 'user', content: m.content.map((b) => (b.type === 'text' ? { type: 'text' as const, text: b.text } : { type: 'tool_result' as const, tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error })) };
}

/**
 * Deterministic rules-based stand-in used when no model is configured: the product works (and is testable) without a key.
 * It calls the same tools through the same checks as a real model would, and writes its answers only from tool results.
 */
export class OfflineProvider implements LlmProvider {
  readonly name = 'offline';
  readonly model = 'offline-rules-1';

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const last = [...req.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
    const q = (typeof last?.content === 'string' ? last.content : '').toLowerCase();
    const results = collectResults(req.messages);
    const done = (text: string): LlmResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: this.model });
    const call = (name: string, input: Record<string, unknown>): LlmResponse => ({ content: [{ type: 'tool_use', id: `off_${name}_${results.length}`, name, input }], stopReason: 'tool_use', usage, model: this.model });
    const has = (name: string) => results.find((r) => r.tool === name);
    const names = new Set(req.tools.map((t) => t.name));
    const pick = (name: string, input: Record<string, unknown> = {}) => (names.has(name) ? call(name, input) : done(`I can't do that here: the "${name}" capability is not available to you.`));

    if (/\b(test action|try the approval|approval demo|demo approval)\b/.test(q)) {
      const r = has('create_approval_request');
      if (!r) return pick('create_approval_request', { action: 'test_action', note: 'Approval lifecycle check from the copilot' });
      return done(`I've prepared a harmless test action. Nothing has happened yet: press "Request approval" on the card below, then a manager approves it. When approved, it only writes a note to a test log.`);
    }
    if (/\b(draft|write|prepare)\b.*\b(reminder|rent reminder)\b|\breminder\b.*\bdraft\b/.test(q)) {
      const od = has('get_overdue_rent');
      if (!od) return pick('get_overdue_rent', {});
      const items: any[] = od.data.items ?? [];
      const name = items.find((i) => q.includes(String(i.tenant_name ?? '').toLowerCase()) && i.tenant_name);
      const target = name ?? items.find((i) => i.can_email);
      if (!target) return done('Nobody with overdue rent has an email address on file that I can draft a reminder for.');
      const dr = has('draft_rent_reminder');
      if (!dr) return pick('draft_rent_reminder', { charge_id: target.charge_ids[0] });
      if (dr.error) return done(`I couldn't prepare that draft: ${dr.error}`);
      return done(`I drafted a reminder for ${target.tenant_name} (${target.property_name} ${target.unit_reference}) for the outstanding ${target.overdue_display}. Nothing has been sent. Please review the wording below.`);
    }
    if (/overdue|late rent|arrears|behind on rent|owe/.test(q)) {
      const od = has('get_overdue_rent');
      if (!od) return pick('get_overdue_rent', {});
      const d = od.data; const items: any[] = d.items ?? [];
      if (!d.total_tenancies) return done(`No rent is overdue as of ${asOf(d)}.`);
      const lines = items.slice(0, 10).map((i) => `- ${i.tenant_name}, ${i.property_name} ${i.unit_reference}: ${i.overdue_display} overdue (${i.max_days_overdue} days, oldest due ${i.oldest_due_date})`);
      const tot = (d.totals_by_currency ?? []).map((t: any) => `${t.overdue_display} across ${t.tenancies} tenanc${t.tenancies === 1 ? 'y' : 'ies'}`).join('; ');
      return done([`Overdue rent as of ${asOf(d)}: ${tot}.`, ...lines, d.total_tenancies > items.length ? `…and ${d.total_tenancies - Math.min(items.length, 10)} more.` : '', 'Basis: unpaid charges past their due date; any unallocated credit on a tenancy is shown separately and not subtracted.'].filter(Boolean).join('\n'));
    }
    if (/income|collect|revenue|billed|rent (this|for the) month|takings/.test(q)) {
      const cs = has('get_rent_collection_summary');
      if (!cs) return pick('get_rent_collection_summary', {});
      const d = cs.data; const rows: any[] = d.rows ?? [];
      if (!rows.length) return done(`There are no billed charges between ${d.scope?.period_from} and ${d.scope?.period_to}.`);
      const lines = rows.map((r) => `- ${r.property_name ?? r.property_id}: billed ${r.billed_display ?? r.billed_minor}, collected ${r.collected_display ?? r.collected_minor}`);
      return done([`Rent for ${d.scope?.period_from} to ${d.scope?.period_to} (${d.scope?.period_defaulted ? 'this month to date' : 'as requested'}):`, ...lines, `Basis: ${d.basis}`].join('\n'));
    }
    if (/lease|expir|ending|end date|renew/.test(q)) {
      const days = Number(/(\d{1,3})\s*days?/.exec(q)?.[1] ?? 60);
      const le = has('get_lease_expiries');
      if (!le) return pick('get_lease_expiries', { within_days: days });
      const d = le.data; const items: any[] = d.items ?? [];
      if (!items.length) return done(`No active tenancies have an end date in the next ${d.scope?.within_days} days.${d.open_ended_active_tenancies ? ` (${d.open_ended_active_tenancies} open-ended tenancies have no end date.)` : ''}`);
      return done([`${items.length} lease${items.length === 1 ? '' : 's'} ending within ${d.scope?.within_days} days:`, ...items.map((i) => `- ${i.tenant_name}, ${i.property_name} ${i.unit_reference}: ends ${i.end_date} (${i.days_left} days)`)].join('\n'));
    }
    if (/maintenance|repair|unresolved|broken|leak|issue|ticket/.test(q)) {
      const mr = has('get_maintenance_requests');
      if (!mr) return pick('get_maintenance_requests', { unresolved_only: true });
      const d = mr.data; const items: any[] = d.items ?? [];
      if (!d.total) return done('There are no unresolved maintenance requests.');
      return done([`${d.total} unresolved maintenance request${d.total === 1 ? '' : 's'}:`, ...items.slice(0, 10).map((i) => `- ${i.critical ? '[CRITICAL] ' : ''}${i.title} (${i.property_name}${i.unit_reference ? ' ' + i.unit_reference : ''}), ${i.status}, open ${i.days_open} days`)].join('\n'));
    }
    if (/portfolio|summary|overview|how many|occupan|vacan|status/.test(q)) {
      const ps = has('get_portfolio_summary');
      if (!ps) return pick('get_portfolio_summary', {});
      const d = ps.data;
      return done(`As of ${asOf(d)}: ${d.properties} properties, ${d.units?.total} units (${d.units?.occupied} occupied, ${d.units?.vacant} vacant), ${d.active_tenancies} active tenancies, ${d.maintenance?.unresolved} unresolved maintenance requests.`);
    }
    return done('I can help with overdue rent, rent collected this month, leases ending soon, unresolved maintenance and a portfolio overview, and I can prepare reminders and maintenance requests for your approval. Try "Who is overdue on rent?" or "Draft a reminder for the largest overdue balance".');
  }
}

const asOf = (d: any) => String(d?.as_of ?? '').slice(0, 10);

/** Pair each tool_use with its parsed result, so rules can read what the tools returned. */
function collectResults(messages: Message[]): { tool: string; data: any; error?: string }[] {
  const names = new Map<string, string>();
  const out: { tool: string; data: any; error?: string }[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const raw = b.content.replace(/^<untrusted_data[^>]*>\n?/, '').replace(/\n?<\/untrusted_data>$/, '');
        let data: any = null; try { data = JSON.parse(raw); } catch { /* error text */ }
        out.push({ tool: names.get(b.tool_use_id) ?? '', data: data ?? {}, error: b.is_error ? (data?.error ?? raw) : undefined });
      }
    }
  }
  return out;
}

export function createProvider(env: Env): LlmProvider {
  return env.LLM_PROVIDER === 'anthropic' ? new AnthropicProvider(env) : new OfflineProvider();
}
