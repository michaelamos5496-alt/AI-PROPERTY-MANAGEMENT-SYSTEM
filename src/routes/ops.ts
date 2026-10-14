import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../lib/env.js';
import * as S from '../lib/schemas.js';
import { uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import { MAINTENANCE_BUCKET, type DataApi, type StorageApi } from '../services/supabase.js';
import { AppError } from '../lib/errors.js';
import { mountDefs, type Def, type MountOptions } from './defs.js';

const noBody = z.object({});
const vendorUpdate = S.vendorBody.extend({ expectedVersion: S.version });

/** Organization-scoped (staff) endpoints for maintenance, vendors, approvals, delivery and tenant-portal administration. */
export const opsOrgDefs: Def[] = [
  // maintenance requests
  { method: 'get', path: '/maintenance', min: 'staff', fn: 'list_requests', query: S.requestsQuery },
  { method: 'post', path: '/maintenance', min: 'staff', fn: 'create_maintenance_request', body: S.maintCreateBody, status: 201 },
  { method: 'get', path: '/maintenance/:request', min: 'staff', fn: 'get_request' },
  { method: 'post', path: '/maintenance/:request/triage', min: 'staff', fn: 'triage_request', body: S.triageBody },
  { method: 'post', path: '/maintenance/:request/cancel', min: 'staff', fn: 'cancel_request', body: S.cancelRequestBody },
  { method: 'post', path: '/maintenance/:request/resolve', min: 'staff', fn: 'resolve_request', body: S.resolveBody },
  { method: 'post', path: '/maintenance/:request/reopen', min: 'manager', fn: 'reopen_request', body: S.cancelRequestBody },
  { method: 'post', path: '/maintenance/:request/urgency', min: 'staff', fn: 'change_urgency', body: S.urgencyChangeBody },
  { method: 'post', path: '/maintenance/:request/suggested-urgency', min: 'staff', fn: 'set_suggested_urgency', body: S.suggestBody },
  { method: 'post', path: '/maintenance/:request/acknowledge', min: 'manager', fn: 'acknowledge_escalation', body: noBody },
  { method: 'post', path: '/maintenance/:request/notes', min: 'staff', fn: 'add_request_note', body: S.noteBody, status: 201 },
  { method: 'post', path: '/maintenance/:request/work-orders', min: 'staff', fn: 'assign_work', body: S.assignBody, status: 201 },
  { method: 'post', path: '/work-orders/:work_order/estimates', min: 'staff', fn: 'submit_estimate', body: S.estimateBody, status: 201 },
  { method: 'post', path: '/work-orders/:work_order/start', min: 'staff', fn: 'start_work', body: noBody },
  { method: 'post', path: '/work-orders/:work_order/complete', min: 'staff', fn: 'complete_work', body: S.completeBody },
  { method: 'post', path: '/work-orders/:work_order/cancel', min: 'manager', fn: 'cancel_work_order', body: S.reasonBody },
  { method: 'post', path: '/attachments/:attachment/archive', min: 'staff', fn: 'archive_attachment', body: noBody },
  // vendors
  { method: 'get', path: '/vendors', min: 'staff', fn: 'list_vendors', query: S.vendorsQuery },
  { method: 'post', path: '/vendors', min: 'manager', fn: 'save_vendor', body: S.vendorBody, extra: { vendor: null, expectedVersion: null }, status: 201 },
  { method: 'patch', path: '/vendors/:vendor', min: 'manager', fn: 'save_vendor', body: vendorUpdate },
  { method: 'post', path: '/vendors/:vendor/archive', min: 'manager', fn: 'set_vendor_archived', extra: { archived: true }, body: noBody },
  { method: 'post', path: '/vendors/:vendor/restore', min: 'manager', fn: 'set_vendor_archived', extra: { archived: false }, body: noBody },
  // urgency levels and settings
  { method: 'get', path: '/urgency-levels', min: 'staff', fn: 'list_urgency_levels' },
  { method: 'post', path: '/urgency-levels', min: 'manager', fn: 'save_urgency_level', body: S.urgencyLevelBody, extra: { id: null }, status: 201 },
  { method: 'patch', path: '/urgency-levels/:id', min: 'manager', fn: 'save_urgency_level', body: S.urgencyLevelBody },
  { method: 'post', path: '/urgency-levels/:id/archive', min: 'manager', fn: 'set_urgency_archived', extra: { archived: true }, body: noBody },
  { method: 'post', path: '/urgency-levels/:id/restore', min: 'manager', fn: 'set_urgency_archived', extra: { archived: false }, body: noBody },
  { method: 'get', path: '/maintenance-settings', min: 'staff', fn: 'get_maintenance_settings' },
  { method: 'put', path: '/maintenance-settings', min: 'admin', fn: 'update_maintenance_settings', body: S.maintSettingsBody },
  // approvals
  { method: 'get', path: '/approvals', min: 'staff', fn: 'list_approvals', query: S.approvalsQuery },
  { method: 'post', path: '/approvals', min: 'staff', fn: 'request_approval', body: S.approvalRequestBody, status: 201 },
  { method: 'get', path: '/approvals/:approval', min: 'staff', fn: 'get_approval' },
  { method: 'post', path: '/approvals/:approval/decision', min: 'staff', fn: 'decide_approval', body: S.decisionBody },
  { method: 'post', path: '/approvals/:approval/retry', min: 'staff', fn: 'retry_approval', body: noBody },
  { method: 'post', path: '/approvals/:approval/cancel', min: 'staff', fn: 'cancel_approval', body: S.approvalNoteBody },
  // notification preferences, delivery visibility and jobs
  { method: 'get', path: '/notification-prefs', min: 'viewer', fn: 'get_my_notification_prefs' },
  { method: 'post', path: '/notification-prefs', min: 'viewer', fn: 'set_my_notification_pref', body: S.prefBody },
  { method: 'get', path: '/email-queue', min: 'manager', fn: 'list_email_queue', query: S.emailQueueQuery },
  { method: 'post', path: '/email-queue/:email/requeue', min: 'manager', fn: 'requeue_email', body: noBody },
  { method: 'post', path: '/jobs/run', min: 'manager', fn: 'run_org_jobs', body: noBody },
  { method: 'get', path: '/jobs', min: 'manager', fn: 'list_job_runs', query: S.jobRunsQuery },
  // tenant portal administration
  { method: 'get', path: '/tenants/:tenant/portal-access', min: 'manager', fn: 'get_tenant_portal_access' },
  { method: 'post', path: '/portal-access/:link/revoke', min: 'manager', fn: 'revoke_tenant_portal_access', body: noBody },
  { method: 'post', path: '/tenants/:tenant/reminders', min: 'staff', fn: 'set_tenant_reminders', body: S.reminderBody },
];

/** Endpoints that act on the signed-in user's own data (staff or tenant), with no organization role. */
export const opsUserDefs: Def[] = [
  { method: 'get', path: '/notifications', min: 'viewer', scope: 'user', fn: 'list_my_notifications', query: S.notificationsQuery },
  { method: 'post', path: '/notifications/read', min: 'viewer', scope: 'user', fn: 'mark_my_notifications_read', body: S.markReadBody },
];

/** Tenant portal: the caller must be a verified tenant; the database decides, per call, whether they may see or do the thing. */
export const opsPortalDefs: Def[] = [
  { method: 'get', path: '/context', min: 'viewer', scope: 'user', fn: 'portal_context' },
  { method: 'get', path: '/requests', min: 'viewer', scope: 'user', fn: 'portal_list_requests' },
  { method: 'get', path: '/orgs/:orgId/urgency-levels', min: 'viewer', scope: 'portal', fn: 'portal_urgency_levels' },
  { method: 'post', path: '/orgs/:orgId/requests', min: 'viewer', scope: 'portal', fn: 'portal_submit_request', body: S.portalRequestBody, status: 201 },
  { method: 'get', path: '/orgs/:orgId/requests/:request', min: 'viewer', scope: 'portal', fn: 'portal_get_request' },
  { method: 'post', path: '/orgs/:orgId/requests/:request/notes', min: 'viewer', scope: 'portal', fn: 'add_request_note', body: S.portalNoteBody, extra: { visibility: 'tenant' }, status: 201 },
  { method: 'post', path: '/orgs/:orgId/requests/:request/cancel', min: 'viewer', scope: 'portal', fn: 'cancel_request', body: S.cancelRequestBody },
];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sanitizeAttachment = (d: any) => { if (d && typeof d === 'object') delete d.storage_path; return d; };

/** Upload/confirm/download for maintenance attachments, shared by staff and tenants. Access is decided by the database per call. */
function attachmentRoutes(r: Router, data: DataApi, storage: StorageApi, gate: ReturnType<typeof requireOrgRole>[], orgOf: (req: any) => string, requestBase: string, attachmentBase: string) {
  const tok = (req: any) => req.auth.token as string;
  r.post(`${requestBase}/attachments`, ...gate, validate({ params: z.object({ request: uuid }).passthrough(), body: S.attachmentBody }), async (req, res) => {
    const att = await data.rpc<{ id: string; storage_path: string; mime_type: string }>(tok(req), 'create_maintenance_attachment',
      { p_org: orgOf(req), p_request: req.params.request, p_file_name: req.body.fileName, p_mime_type: req.body.mimeType, p_size_bytes: req.body.sizeBytes, p_visibility: req.body.visibility });
    const url = await storage.signUpload(tok(req), att.storage_path, MAINTENANCE_BUCKET);
    res.status(201).json({ attachment: sanitizeAttachment({ ...att }), upload: { url, method: 'PUT', headers: { 'content-type': att.mime_type } } });
  });
  r.post(`${attachmentBase}/:attachment/confirm`, ...gate, validate({ params: z.object({ attachment: uuid }).passthrough() }), async (req, res) => {
    const pending = await data.rpc<{ storage_path: string }>(tok(req), 'get_pending_attachment', { p_org: orgOf(req), p_attachment: req.params.attachment });
    const info = await storage.info(tok(req), pending.storage_path, MAINTENANCE_BUCKET);
    if (!info) throw AppError.conflict('The file has not finished uploading. Try again.');
    res.json(sanitizeAttachment(await data.rpc(tok(req), 'confirm_maintenance_attachment', { p_org: orgOf(req), p_attachment: req.params.attachment, p_size_bytes: info.size, p_mime_type: info.contentType })));
  });
  r.get(`${attachmentBase}/:attachment/download`, ...gate, validate({ params: z.object({ attachment: uuid }).passthrough() }), async (req, res) => {
    const a = await data.rpc<{ storage_path: string; file_name: string; id: string }>(tok(req), 'get_attachment_access', { p_org: orgOf(req), p_attachment: req.params.attachment });
    req.log.info('attachment download', { attachmentId: a.id, orgId: orgOf(req), userId: req.auth!.user.id });
    res.json({ url: await storage.signDownload(tok(req), a.storage_path, a.file_name, 60, MAINTENANCE_BUCKET), expiresInSeconds: 60 });
  });
}

export function opsRoutes(env: Env, data: DataApi, storage: StorageApi, opts: MountOptions): Router {
  const r = Router({ mergeParams: true });
  mountDefs(r, opsOrgDefs, data, opts);
  attachmentRoutes(r, data, storage, [requireOrgRole(data, 'staff')], (req) => req.org.id, '/maintenance/:request', '/attachments');

  // Inviting a tenant to the portal: the raw token is shown once and only its hash is stored.
  r.post('/tenants/:tenant/portal-invitations', requireOrgRole(data, 'manager'), validate({ params: z.object({ tenant: uuid }).passthrough(), body: noBody }), async (req, res) => {
    const token = randomBytes(32).toString('base64url');
    const invitation = await data.rpc(req.auth!.token, 'invite_tenant_to_portal', { p_org: req.org!.id, p_tenant: req.params.tenant, p_token_hash: sha256(token) });
    await opts.afterWrite?.({ method: 'post' } as Def);
    res.status(201).json({ invitation, inviteUrl: `${env.APP_URL}/portal-invite#token=${token}` });
  });
  return r;
}

export function userRoutes(data: DataApi, opts: MountOptions): Router {
  const r = Router();
  mountDefs(r, opsUserDefs, data, opts);
  return r;
}

export function portalRoutes(data: DataApi, storage: StorageApi, opts: MountOptions): Router {
  const r = Router();
  mountDefs(r, opsPortalDefs, data, opts);
  attachmentRoutes(r, data, storage, [], (req) => req.params.orgId, '/orgs/:orgId/requests/:request', '/orgs/:orgId/attachments');
  r.post('/invitations/accept', validate({ body: S.tokenBody }), async (req, res) => {
    res.json(await data.rpc(req.auth!.token, 'accept_tenant_invitation', { p_token_hash: sha256(req.body.token) }));
  });
  return r;
}
