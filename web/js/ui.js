/** Tiny DOM builder. Children are always text nodes or elements, never HTML strings (no XSS sink). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { el.replaceChildren(); return el; };

/* ---------------------------------------------------------------- toasts */
let toastRoot;
export function toast(message, type = 'info', ms = 5000) {
  toastRoot ??= document.body.appendChild(h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' }));
  const el = h('div', { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', {}, message),
    h('button', { type: 'button', 'aria-label': 'Dismiss notification', onclick: () => el.remove() }, '×'));
  toastRoot.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

/* ---------------------------------------------------------------- dialogs */
/**
 * Accessible modal built on <dialog>: focus is trapped by the browser, Esc closes,
 * focus returns to the opener, and the title labels the dialog for screen readers.
 * `actions`: [{ label, variant, onClick(close) , close: true }]
 */
export function openDialog({ title, body, actions = [], closeLabel = 'Close' }) {
  const opener = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': titleId },
    h('div', { class: 'dialog__body' }, h('h2', { id: titleId }, title), body),
    h('div', { class: 'dialog__footer' },
      ...actions.map((a) => h('button', {
        type: 'button', class: `btn ${a.variant ? 'btn--' + a.variant : ''}`,
        onclick: async (e) => {
          if (a.onClick) { setLoading(e.currentTarget, true); try { await a.onClick(() => dlg.close()); } finally { setLoading(e.currentTarget, false); } }
          else dlg.close();
        },
      }, a.label)),
      !actions.length && h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, closeLabel)));
  dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = openDialog({
      title, body: h('p', {}, message),
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        { label: confirmLabel, variant: danger ? 'danger' : '', onClick: (close) => { resolve(true); close(); } },
      ],
    });
    dlg.addEventListener('close', () => resolve(false));
  });
}

/* ---------------------------------------------------------- loading / empty */
export function setLoading(btn, on) {
  if (!btn) return;
  btn.toggleAttribute('disabled', on);
  if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
}

export const skeleton = (lines = 3) =>
  h('div', { role: 'status', 'aria-label': 'Loading' },
    h('span', { class: 'skeleton skeleton--title' }),
    ...Array.from({ length: lines }, () => h('span', { class: 'skeleton' })),
    h('span', { class: 'visually-hidden' }, 'Loading…'));

export const emptyState = ({ icon = '📭', title, text, action }) =>
  h('div', { class: 'empty' }, h('div', { class: 'empty__icon', 'aria-hidden': 'true' }, icon),
    h('h3', {}, title), text && h('p', {}, text), action);

/* -------------------------------------------------------------------- forms */
export function showFormError(form, err) {
  const box = form.querySelector('[data-form-error]');
  form.querySelectorAll('[aria-invalid]').forEach((i) => { i.removeAttribute('aria-invalid'); });
  form.querySelectorAll('.field__error').forEach((n) => n.remove());
  if (!err) { if (box) box.hidden = true; return; }
  let fieldLevel = false;
  for (const d of err.details ?? []) {
    const input = d.in === 'body' && form.elements[d.path];
    if (input?.setAttribute) {
      fieldLevel = true;
      input.setAttribute('aria-invalid', 'true');
      const id = `${input.id || input.name}-err`;
      input.setAttribute('aria-describedby', id);
      input.closest('.field')?.append(h('div', { class: 'field__error', id }, d.message));
    }
  }
  if (box && !fieldLevel) { box.textContent = err.message; box.hidden = false; box.focus?.(); }
  else if (box) box.hidden = true;
}

/** Wire a form: disables the button while submitting and routes errors to the UI. */
export function handleForm(form, onSubmit) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    showFormError(form, null);
    setLoading(btn, true);
    try { await onSubmit(Object.fromEntries(new FormData(form))); }
    catch (err) { showFormError(form, err); if (!err.status && !err.details) console.error(err); }
    finally { setLoading(btn, false); }
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.', 'success', 2500); }
  catch { toast('Copy failed. Select the text and copy it manually.', 'error'); }
}
