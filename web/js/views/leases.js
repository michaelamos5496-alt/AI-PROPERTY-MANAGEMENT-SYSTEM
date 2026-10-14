import { get, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { LABELS, archivedBadge, crumbs, dl, errorState, fmtBytes, fmtDate, fmtTimestamp, formDialog, options, pageHeader, section, statusBadge } from '../kit.js';
import { openLeaseForm } from './tenancies.js';

const MAX = 10 * 1024 * 1024;
const TYPES = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX' };

/** PUT with progress (fetch cannot report upload progress). */
function putWithProgress(url, headers, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413 ? 'The file is too large.' : xhr.status === 415 ? 'That file type is not allowed.' : 'Upload failed. Please try again.')));
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.send(file);
  });
}

function openUploadDialog(ctx, lease, done) {
  const file = h('input', { class: 'input', type: 'file', id: 'doc-file', accept: Object.keys(TYPES).join(','), required: true });
  const bar = h('span');
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Upload progress', 'aria-valuemin': 0, 'aria-valuemax': 100, hidden: true }, bar);
  formDialog({
    title: 'Upload lease document', intro: 'Stored privately. Only staff, managers, admins and owners of this organization can open it.',
    fields: [{ name: 'docType', label: 'Document type', type: 'select', required: true, options: options(LABELS.docType), default: 'lease', wide: true }],
    extra: [h('div', { class: 'field field--wide' }, h('label', { for: 'doc-file' }, 'File (PDF, PNG, JPEG or DOCX, max 10 MB)'), file, progress)],
    submitLabel: 'Upload',
    onSubmit: async (v) => {
      const f = file.files[0];
      const fail = (message) => { throw Object.assign(new Error(message), { details: [] }); };
      if (!f) fail('Choose a file to upload.');
      if (!TYPES[f.type]) fail('Only PDF, PNG, JPEG or DOCX files are allowed.');
      if (f.size > MAX) fail('Files can be at most 10 MB.');
      if (f.size === 0) fail('That file is empty.');
      progress.hidden = false;
      const reg = await post(`${ctx.base}/leases/${lease.id}/documents`, { docType: v.docType, fileName: f.name, mimeType: f.type, sizeBytes: f.size });
      await putWithProgress(reg.upload.url, reg.upload.headers, f, (p) => { bar.style.width = `${Math.round(p * 100)}%`; progress.setAttribute('aria-valuenow', Math.round(p * 100)); });
      await post(`${ctx.base}/documents/${reg.document.id}/confirm`, {});
      toast('Document uploaded.', 'success');
      done();
    },
  });
}

export function leaseView(ctx, id) {
  const root = h('div', {}, skeleton(4));
  async function render() {
    let l;
    try { l = await get(`${ctx.base}/leases/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const t = l.tenancy; const archived = !!l.archived_at; const canDocs = l.documents_visible;
    const download = async (d) => {
      try { const r = await get(`${ctx.base}/documents/${d.id}/download`); location.assign(r.url); }
      catch (e) { toast(e.message, 'error'); }
    };
    const act = async (d, verb) => {
      if (verb === 'archive' && !(await confirmDialog({ title: `Archive “${d.file_name}”?`, message: 'It is hidden from staff but kept on record, and a manager can restore it.', confirmLabel: 'Archive', danger: true }))) return;
      try { await post(`${ctx.base}/documents/${d.id}/${verb}`, {}); toast(verb === 'archive' ? 'Document archived.' : 'Document restored.', 'success'); render(); }
      catch (e) { toast(e.message, 'error'); }
    };
    const docs = !canDocs
      ? emptyState({ icon: '🔒', title: 'Documents are restricted', text: 'Lease documents are only visible to staff, managers, admins and owners.' })
      : l.documents.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Lease documents'),
            h('thead', {}, h('tr', {}, ['Name', 'Type', 'Size', 'Uploaded', ''].map((c) => h('th', { scope: 'col' }, c || h('span', { class: 'visually-hidden' }, 'Actions'))))),
            h('tbody', {}, l.documents.map((d) => h('tr', { class: d.archived ? 'row--archived' : false },
              h('td', { 'data-label': 'Name' }, d.file_name, ' ', archivedBadge(d)), h('td', { 'data-label': 'Type' }, LABELS.docType[d.doc_type]),
              h('td', { class: 'num', 'data-label': 'Size' }, fmtBytes(d.size_bytes)), h('td', { 'data-label': 'Uploaded' }, fmtTimestamp(d.created_at)),
              h('td', { class: 'actions' },
                (!d.archived || ctx.can('records:archive')) && h('button', { class: 'btn btn--secondary btn--sm', type: 'button', 'aria-label': `Download ${d.file_name}`, onclick: () => download(d) }, 'Download'), ' ',
                ctx.can('records:archive') && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `${d.archived ? 'Restore' : 'Archive'} ${d.file_name}`, onclick: () => act(d, d.archived ? 'restore' : 'archive') }, d.archived ? 'Restore' : 'Archive')))))))
        : emptyState({ icon: '📎', title: 'No documents yet', text: 'Upload the signed lease and any addenda. Files are private to your organization.',
            action: ctx.can('documents:write') && !archived ? h('button', { class: 'btn', type: 'button', onclick: () => openUploadDialog(ctx, l, render) }, 'Upload document') : null });

    clear(root).append(
      crumbs({ label: 'Tenancies', href: '#/tenancies' }, { label: `${t.property_name} · ${t.unit_reference}`, href: `#/tenancies/${t.id}` }, { label: LABELS.leaseKind[l.kind] }),
      pageHeader(LABELS.leaseKind[l.kind], { subtitle: `${t.primary_tenant ?? 'Tenant'} · ${t.property_name} · ${t.unit_reference}`, badges: [statusBadge(t.status), archivedBadge(l)],
        actions: [ctx.can('leases:write') && !archived && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openLeaseForm(ctx, t, l, render) }, 'Edit'),
          ctx.can('records:archive') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => {
            if (!archived && !(await confirmDialog({ title: 'Archive this lease?', message: 'Its documents are kept. A manager can restore it.', confirmLabel: 'Archive', danger: true }))) return;
            try { await post(`${ctx.base}/leases/${l.id}/${archived ? 'restore' : 'archive'}`, {}); toast(archived ? 'Lease restored.' : 'Lease archived.', 'success'); render(); } catch (e) { toast(e.message, 'error'); }
          } }, archived ? 'Restore' : 'Archive')] }),
      section('Lease', dl([['Tenancy', h('a', { href: `#/tenancies/${t.id}` }, `${t.property_name} · ${t.unit_reference}`)], ['Signed', fmtDate(l.signed_on)],
        ['Term', `${fmtDate(l.start_date)} → ${l.end_date ? fmtDate(l.end_date) : 'open'}`], ['Notes', l.notes]])),
      section('Documents', docs, canDocs && ctx.can('documents:write') && !archived && l.documents.length > 0 && h('button', { class: 'btn btn--sm', type: 'button', onclick: () => openUploadDialog(ctx, l, render) }, 'Upload document')));
  }
  render();
  return root;
}
