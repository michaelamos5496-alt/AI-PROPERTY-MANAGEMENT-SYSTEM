import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { loadEnv } from './lib/env.js';

/** Local server: the API plus the built static site from ./public (mirrors Vercel routing). */
export function createDevServer(env = loadEnv()) {
  const api = createApp({ env });
  const server = express();
  // Serve the same security headers (incl. CSP) that vercel.json applies in production.
  const vercel = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'vercel.json'), 'utf8'));
  const global = vercel.headers.find((h: { source: string }) => h.source === '/(.*)').headers as { key: string; value: string }[];
  // Signed uploads go browser -> Supabase Storage, so connect-src also needs the project origin
  // (production uses https://*.supabase.co from vercel.json; locally it may be http://127.0.0.1).
  const supabaseOrigin = new URL(env.SUPABASE_URL).origin;
  const withStorage = (v: string) => v.replace("connect-src 'self'", `connect-src 'self' ${supabaseOrigin}`);
  server.use((_req, res, next) => { for (const { key, value } of global) res.setHeader(key, key === 'Content-Security-Policy' ? withStorage(value) : value); next(); });
  server.use('/api', (req, res, next) => { req.url = '/api' + req.url; api(req, res, next); });
  server.use(express.static(join(import.meta.dirname, '..', 'public'), { extensions: ['html'] }));
  return server;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const env = loadEnv();
  createDevServer(env).listen(env.PORT, () => console.log(`Property AI dev server: http://localhost:${env.PORT}`));
}
