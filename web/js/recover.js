import { post } from './api.js';
import { handleForm } from './ui.js';

const form = document.getElementById('form');
handleForm(form, async (v) => {
  await post('/auth/recover', { email: v.email });
  form.hidden = true;
  document.getElementById('done').hidden = false;
});
