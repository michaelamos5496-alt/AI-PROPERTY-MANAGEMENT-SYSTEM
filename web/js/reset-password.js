import { get, post } from './api.js';
import { handleForm } from './ui.js';

const form = document.getElementById('form');
get('/me').catch(() => {
  form.hidden = true;
  document.getElementById('expired').hidden = false;
});
handleForm(form, async (v) => {
  if (v.password !== v.confirm) throw Object.assign(new Error('The passwords do not match.'), { details: [] });
  await post('/auth/password', { password: v.password });
  location.assign('/app');
});
