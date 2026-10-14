import { get, homeFor } from './api.js';
// Signed-in visitors skip the landing page.
get('/me').then(async (me) => location.replace(await homeFor(me))).catch(() => {});
