import { Router } from 'express';
import { z } from 'zod';
import { runTurn } from '../ai/agent.js';
import type { LlmProvider } from '../ai/types.js';
import type { Env } from '../lib/env.js';
import { rateLimit } from '../lib/rate-limit.js';
import { uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import type { DataApi, ServiceApi } from '../services/supabase.js';
import { mountDefs, type Def, type MountOptions } from './defs.js';

const noBody = z.object({});
const noteBody = z.object({ note: z.string().trim().max(500).nullish().transform((v) => v ?? null) });
const settingsBody = z.object({
  enabled: z.boolean().nullable().default(null), externalEnabled: z.boolean().nullable().default(null),
  dailyBudgetMicro: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null), maxTurnsPerUserHour: z.number().int().min(1).max(1000).nullable().default(null),
}).strict();
const actionsQuery = z.object({ conversation: uuid.optional(), scope: z.enum(['mine', 'org']).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
const messageBody = z.object({ content: z.string().trim().min(1, 'Type a question.').max(4000) }).strict();

export const copilotDefs: Def[] = [
  { method: 'get', path: '/copilot/conversations', min: 'staff', fn: 'list_copilot_conversations' },
  { method: 'post', path: '/copilot/conversations', min: 'staff', fn: 'create_copilot_conversation', body: noBody, status: 201 },
  { method: 'get', path: '/copilot/conversations/:conversation', min: 'staff', fn: 'get_copilot_conversation' },
  { method: 'post', path: '/copilot/conversations/:conversation/archive', min: 'staff', fn: 'archive_copilot_conversation', body: noBody },
  { method: 'post', path: '/copilot/conversations/:conversation/cancel', min: 'staff', fn: 'copilot_cancel_turn', body: noBody },
  { method: 'get', path: '/copilot/actions', min: 'staff', fn: 'list_copilot_actions', query: actionsQuery },
  { method: 'post', path: '/copilot/actions/:action/confirm', min: 'staff', fn: 'copilot_confirm_action', body: noBody },
  { method: 'post', path: '/copilot/actions/:action/submit', min: 'staff', fn: 'copilot_submit_action', body: noBody },
  { method: 'post', path: '/copilot/actions/:action/cancel', min: 'staff', fn: 'copilot_cancel_action', body: noteBody },
  { method: 'post', path: '/copilot/demo-action', min: 'staff', fn: 'copilot_demo_action', body: z.object({ note: z.string().trim().min(3).max(500) }).strict(), status: 201 },
  { method: 'put', path: '/copilot/settings', min: 'admin', fn: 'update_copilot_settings', body: settingsBody },
];

/** The copilot panel's API. Reads and decisions go straight to the database as the signed-in user; model turns run through the agent. */
export function copilotRoutes(env: Env, data: DataApi, service: ServiceApi, llm: LlmProvider, opts: MountOptions & { log: import('../lib/logger.js').Logger }): Router {
  const r = Router({ mergeParams: true });
  r.get('/copilot/status', requireOrgRole(data, 'staff'), async (req, res) => {
    const settings = await data.rpc<any>(req.auth!.token, 'get_copilot_settings', { p_org: req.org!.id });
    res.json({
      provider: llm.name, model: llm.model, settings, role: req.org!.role, serviceConfigured: service.configured,
      externalSwitchOn: env.COPILOT_EXTERNAL_ENABLED, externalEffective: env.COPILOT_EXTERNAL_ENABLED && !!settings.external_enabled,
    });
  });
  mountDefs(r, copilotDefs, data, opts);
  r.post('/copilot/conversations/:conversation/messages',
    requireOrgRole(data, 'staff'),
    rateLimit({ name: 'copilot-turn', windowSeconds: 60, max: 12, key: (req) => req.auth?.user.id ?? req.ip ?? 'anon' }),
    validate({ params: z.object({ conversation: uuid }).passthrough(), body: messageBody }),
    async (req, res) => {
      if (!service.configured) { res.status(503).json({ error: { code: 'upstream_error', message: 'The copilot is not configured on this server (SUPABASE_SERVICE_ROLE_KEY).' } }); return; }
      const conversationId = String(req.params.conversation);
      const outcome = await runTurn({ env, data, service, llm, log: opts.log }, {
        orgId: req.org!.id, userId: req.auth!.user.id, token: req.auth!.token, conversationId, content: req.body.content, requestId: req.id,
      });
      const conversation = await data.rpc(req.auth!.token, 'get_copilot_conversation', { p_org: req.org!.id, p_conversation: conversationId });
      res.status(201).json({ outcome: { status: outcome.status, toolCalls: outcome.toolCalls }, conversation });
    });
  return r;
}
