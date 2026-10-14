import { get, homeFor, post, safeNext } from './api.js';
import { handleForm } from './ui.js';

const params = new URLSearchParams(location.search);
if (params.get('error') === 'link_expired') {
  const box = document.querySelector('[data-form-error]');
  box.textContent = 'That link has expired or was already used. Request a new one and try again.';
  box.hidden = false;
}
handleForm(document.getElementById('form'), async (v) => {
  await post('/auth/login', { email: v.email, password: v.password });
  const next = params.get('next');
  location.assign(next ? safeNext(next) : await homeFor(await get('/me')));
});
