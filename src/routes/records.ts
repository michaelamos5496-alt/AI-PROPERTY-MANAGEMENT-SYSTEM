import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import * as S from '../lib/schemas.js';
import { uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import { normalizePhones } from '../middleware/phone.js';
import { mountDefs, prefixed, type Def } from './defs.js';
import type { DataApi, StorageApi } from '../services/supabase.js';

const withVersion = <T extends z.ZodRawShape>(shape: T) => z.object({ expectedVersion: S.version, ...shape });
const asVersioned = (schema: z.ZodObject<any>) => withVersion(schema.shape);

const defs: Def[] = [
  // properties
  { method: 'get', path: '/properties', min: 'viewer', fn: 'list_properties', query: S.listQuery },
  { method: 'post', path: '/properties', min: 'manager', fn: 'create_property', body: S.propertyBody, status: 201 },
  { method: 'get', path: '/properties/:property', min: 'viewer', fn: 'get_property' },
  { method: 'patch', path: '/properties/:property', min: 'manager', fn: 'update_property', body: asVersioned(S.propertyBody) },
  { method: 'post', path: '/properties/:property/archive', min: 'manager', fn: 'set_property_archived', extra: { archived: true } },
  { method: 'post', path: '/properties/:property/restore', min: 'manager', fn: 'set_property_archived', extra: { archived: false } },
  // owners
  { method: 'get', path: '/owners', min: 'viewer', fn: 'list_owners', query: S.listQuery },
  { method: 'post', path: '/owners', min: 'manager', fn: 'create_owner', body: S.ownerBody, status: 201 },
  { method: 'patch', path: '/owners/:owner', min: 'manager', fn: 'update_owner', body: asVersioned(S.ownerBody) },
  { method: 'post', path: '/owners/:owner/archive', min: 'manager', fn: 'set_owner_archived', extra: { archived: true } },
  { method: 'post', path: '/owners/:owner/restore', min: 'manager', fn: 'set_owner_archived', extra: { archived: false } },
  { method: 'post', path: '/properties/:property/owners/:owner', min: 'manager', fn: 'link_property_owner',
    body: z.object({ ownershipPct: z.preprocess((v) => (v === '' ? null : v), z.number().gt(0).max(100).nullable().default(null)), isPrimary: z.boolean().default(false) }) },
  { method: 'delete', path: '/properties/:property/owners/:owner', min: 'manager', fn: 'unlink_property_owner' },
  // units
  { method: 'get', path: '/units', min: 'viewer', fn: 'list_units', query: S.listQuery },
  { method: 'post', path: '/properties/:property/units', min: 'manager', fn: 'create_unit', body: S.unitBody, status: 201 },
  { method: 'get', path: '/units/:unit', min: 'viewer', fn: 'get_unit' },
  { method: 'patch', path: '/units/:unit', min: 'manager', fn: 'update_unit', body: asVersioned(S.unitBody) },
  { method: 'post', path: '/units/:unit/archive', min: 'manager', fn: 'set_unit_archived', extra: { archived: true } },
  { method: 'post', path: '/units/:unit/restore', min: 'manager', fn: 'set_unit_archived', extra: { archived: false } },
  // tenants
  { method: 'get', path: '/tenants', min: 'viewer', fn: 'list_tenants', query: S.listQuery },
  { method: 'post', path: '/tenants', min: 'staff', fn: 'create_tenant', body: S.tenantBody, status: 201 },
  { method: 'get', path: '/tenants/:tenant', min: 'viewer', fn: 'get_tenant' },
  { method: 'patch', path: '/tenants/:tenant', min: 'staff', fn: 'update_tenant', body: asVersioned(S.tenantBody) },
  { method: 'post', path: '/tenants/:tenant/archive', min: 'manager', fn: 'set_tenant_archived', extra: { archived: true } },
  { method: 'post', path: '/tenants/:tenant/restore', min: 'manager', fn: 'set_tenant_archived', extra: { archived: false } },
  // tenancies
  { method: 'get', path: '/tenancies', min: 'viewer', fn: 'list_tenancies', query: S.listQuery },
  { method: 'post', path: '/tenancies', min: 'staff', fn: 'create_tenancy', body: S.tenancyCreateBody, status: 201 },
  { method: 'get', path: '/tenancies/:tenancy', min: 'viewer', fn: 'get_tenancy' },
  { method: 'patch', path: '/tenancies/:tenancy', min: 'staff', fn: 'update_tenancy', body: S.tenancyUpdateBody },
  { method: 'post', path: '/tenancies/:tenancy/activate', min: 'manager', fn: 'activate_tenancy', body: z.object({ expectedVersion: S.version }) },
  { method: 'post', path: '/tenancies/:tenancy/end', min: 'manager', fn: 'end_tenancy',
    body: z.object({ expectedVersion: S.version, endDate: S.date, reason: S.text(1000) }) },
  { method: 'post', path: '/tenancies/:tenancy/cancel', min: 'manager', fn: 'cancel_tenancy',
    body: z.object({ expectedVersion: S.version, reason: S.text(1000) }) },
  { method: 'post', path: '/tenancies/:tenancy/tenants/:tenant', min: 'staff', fn: 'add_tenancy_tenant', body: z.object({ isPrimary: z.boolean().default(false) }) },
  { method: 'delete', path: '/tenancies/:tenancy/tenants/:tenant', min: 'staff', fn: 'remove_tenancy_tenant' },
  // leases
  { method: 'post', path: '/tenancies/:tenancy/leases', min: 'staff', fn: 'create_lease', body: S.leaseBody, status: 201 },
  { method: 'get', path: '/leases/:lease', min: 'viewer', fn: 'get_lease' },
  { method: 'patch', path: '/leases/:lease', min: 'staff', fn: 'update_lease', body: asVersioned(S.leaseBody.innerType()) },
  { method: 'post', path: '/leases/:lease/archive', min: 'manager', fn: 'set_lease_archived', extra: { archived: true } },
  { method: 'post', path: '/leases/:lease/restore', min: 'manager', fn: 'set_lease_archived', extra: { archived: false } },
  // document metadata changes
  { method: 'post', path: '/documents/:document/archive', min: 'manager', fn: 'set_document_archived', extra: { archived: true } },
  { method: 'post', path: '/documents/:document/restore', min: 'manager', fn: 'set_document_archived', extra: { archived: false } },
];

/** Mounted at /api/organizations/:orgId (after requireAuth). */
export function recordRoutes(_env: Env, data: DataApi, storage: StorageApi): Router {
  const r = Router({ mergeParams: true });
  const tok = (req: { auth?: { token: string } }) => req.auth!.token;
  const stripPath = (d: any) => { if (d && typeof d === 'object') delete d.storage_path; return d; };

  r.post('/tenants', ...normalizePhones(data, ['phone', 'emergencyPhone']));
  r.patch('/tenants/:tenant', ...normalizePhones(data, ['phone', 'emergencyPhone']));
  mountDefs(r, defs, data);

  // ---- lease documents: metadata in Postgres, bytes in private Storage -----------------------
  r.get('/leases/:lease/documents', requireOrgRole(data, 'staff'), validate({ params: z.object({ lease: uuid }).passthrough() }),
    async (req, res) => {
      const lease = await data.rpc<{ documents: unknown[] }>(tok(req), 'get_lease', { p_org: req.org!.id, p_lease: req.params.lease });
      res.json(lease.documents);
    });

  // 1) register + get a one-time upload URL for exactly this path
  r.post('/leases/:lease/documents', requireOrgRole(data, 'staff'),
    validate({ params: z.object({ lease: uuid }).passthrough(), body: S.documentBody }), async (req, res) => {
      const doc = await data.rpc<{ id: string; storage_path: string; mime_type: string }>(tok(req), 'create_document', {
        p_org: req.org!.id, p_lease: req.params.lease, ...prefixed(req.body),
      });
      const url = await storage.signUpload(tok(req), doc.storage_path);
      res.status(201).json({ document: stripPath({ ...doc }), upload: { url, method: 'PUT', headers: { 'content-type': doc.mime_type } } });
    });

  // 2) after the browser uploaded, verify the object really exists and record its true size/type
  r.post('/documents/:document/confirm', requireOrgRole(data, 'staff'),
    validate({ params: z.object({ document: uuid }).passthrough() }), async (req, res) => {
      const pending = await data.rpc<{ storage_path: string }>(tok(req), 'get_pending_document', { p_org: req.org!.id, p_document: req.params.document });
      const info = await storage.info(tok(req), pending.storage_path);
      if (!info) throw AppError.conflict('The file has not finished uploading. Try again.');
      const out = await data.rpc(tok(req), 'confirm_document', {
        p_org: req.org!.id, p_document: req.params.document, p_size_bytes: info.size, p_mime_type: info.contentType,
      });
      res.json(stripPath(out));
    });

  // 3) authorize against org + role + record, then mint a 60-second signed URL
  r.get('/documents/:document/download', requireOrgRole(data, 'staff'),
    validate({ params: z.object({ document: uuid }).passthrough() }), async (req, res) => {
      const doc = await data.rpc<{ storage_path: string; file_name: string; id: string }>(
        tok(req), 'get_document_access', { p_org: req.org!.id, p_document: req.params.document });
      const url = await storage.signDownload(tok(req), doc.storage_path, doc.file_name);
      req.log.info('document download', { documentId: doc.id, orgId: req.org!.id, userId: req.auth!.user.id });
      res.json({ url, expiresInSeconds: 60 });
    });

  return r;
}
