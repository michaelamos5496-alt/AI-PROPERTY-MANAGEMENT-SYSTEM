import { get, post, signOut } from './api.js';
import { handleForm, toast } from './ui.js';

// The token arrives in the URL fragment (never sent to servers). Keep it only in this tab's
// sessionStorage so it survives a sign-in round trip, and strip it from the address bar.
const KEY = 'pai-invite';
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) {
  try { sessionStorage.setItem(KEY, fromHash); } catch { /* storage unavailable */ }
  history.replaceState(null, '', location.pathname);
}
let token = fromHash;
try { token ??= sessionStorage.getItem(KEY); } catch { /* storage unavailable */ }

const $ = (id) => document.getElementById(id);
if (!token) {
  $('missing').hidden = false;
} else {
  let me = null;
  try { me = await get('/me'); } catch { /* not signed in */ }
  if (!me) {
    $('signed-out').hidden = false;
    const next = encodeURIComponent('/invite');
    $('login-link').href = `/login?next=${next}`;
    $('register-link').href = '/register';
  } else {
    $('accept').hidden = false;
    $('who').textContent = me.profile.email;
    $('switch').addEventListener('click', signOut);
    handleForm($('form'), async () => {
      const org = await post('/invitations/accept', { token });
      try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
      toast(`You joined ${org.name}.`, 'success');
      location.assign(`/app?org=${org.id}`);
    });
  }
}
