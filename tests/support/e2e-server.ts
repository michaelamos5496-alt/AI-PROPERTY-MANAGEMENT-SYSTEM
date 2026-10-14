import { createDevServer } from '../../src/dev.js';
import { loadEnv } from '../../src/lib/env.js';
import { startMockSupabase } from './mock-supabase.js';

const port = Number(process.env.E2E_PORT ?? 3100);
const mock = await startMockSupabase();
const env = loadEnv({
  NODE_ENV: 'test', PORT: String(port), APP_URL: `http://localhost:${port}`,
  SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: mock.anonKey, LOG_LEVEL: 'warn',
  RATE_LIMIT_MAX: '5000', RATE_LIMIT_AUTH_MAX: '500',
});
createDevServer(env).listen(port, () => console.log(`e2e server on ${port}`));
process.on('SIGTERM', async () => { await mock.close(); process.exit(0); });
