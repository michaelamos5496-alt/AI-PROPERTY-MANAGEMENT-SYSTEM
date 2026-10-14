import { post } from './api.js';
import { handleForm } from './ui.js';

const form = document.getElementById('form');
handleForm(form, async (v) => {
  const r = await post('/auth/register', { fullName: v.fullName, email: v.email, password: v.password });
  if (r.needsConfirmation) {
    form.hidden = true;
    document.getElementById('check-email').hidden = false;
    document.getElementById('sent-to').textContent = v.email;
  } else location.assign('/onboarding');
});
