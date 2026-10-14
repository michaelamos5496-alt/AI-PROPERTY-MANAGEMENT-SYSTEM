import { post, requireSession, signOut } from './api.js';
import { handleForm } from './ui.js';

const me = await requireSession();
if (me.memberships.length) location.replace(`/app?org=${me.memberships[0].org_id}`);
document.getElementById('hello').textContent = me.profile.full_name ? `Welcome, ${me.profile.full_name}.` : 'Welcome.';
document.getElementById('signout').addEventListener('click', signOut);
handleForm(document.getElementById('form'), async (v) => {
  const org = await post('/organizations', { name: v.name });
  location.assign(`/app?org=${org.id}`);
});
