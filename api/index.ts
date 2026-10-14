import { createApp } from '../src/app.js';
import { loadEnv } from '../src/lib/env.js';

// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
export default createApp({ env: loadEnv() });
