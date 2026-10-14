/**
 * `npm run dev`.
 *  - With Supabase configured in .env (SUPABASE_URL set): the real app, real sign-in.
 *  - With NOTHING configured: a local demo with fake data that opens already signed in (see scripts/demo.ts), so there is no login screen to get past.
 * The fallback never applies in production (the server refuses to start there without configuration, as before) and runs on 127.0.0.1 only.
 */
if (process.env.SUPABASE_URL) {
  const { loadEnv } = await import('../src/lib/env.js');
  const { createDevServer } = await import('../src/dev.js');
  const env = loadEnv();
  const cb = () => console.log(`Property AI dev server: http://localhost:${env.PORT}`);
  if (env.DEV_AUTO_LOGIN_EMAIL) createDevServer(env).listen(env.PORT, '127.0.0.1', cb); else createDevServer(env).listen(env.PORT, cb);
} else {
  if (process.env.NODE_ENV === 'production') throw new Error('SUPABASE_URL is required in production');
  console.log('No Supabase settings found in .env, so starting the local demo (fake data, signed in automatically).');
  await import('./demo.js');
}
