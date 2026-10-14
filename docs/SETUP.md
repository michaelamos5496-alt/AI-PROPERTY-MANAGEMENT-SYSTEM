# Setup guide

## 1. Supabase project
1. Create a project at supabase.com. Copy **Project URL** and the **anon** key (Settings → API) into `.env`.
2. Link and apply migrations:
   ```bash
   supabase login && supabase link --project-ref <ref>
   supabase db push
   ```
   Local alternative: `supabase start && supabase db reset` (uses `supabase/config.toml`; URL `http://127.0.0.1:54321`).
3. **Authentication → Providers → Email**: enable *Confirm email* (required: invitations are only honoured for
   verified addresses, so an unconfirmed signup can't claim an invited email).
4. **Authentication → URL Configuration**: Site URL = `APP_URL`; add `APP_URL/api/auth/confirm` to Redirect URLs.
5. **Authentication → Email Templates** — point links at the server so sessions are created as cookies:
   * Confirm signup: `{{ .SiteURL }}/api/auth/confirm?token_hash={{ .TokenHash }}&type=signup`
   * Reset password: `{{ .SiteURL }}/api/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`
6. Configure custom SMTP before launch (the built-in sender is heavily rate-limited).

## 2. Vercel
1. Import the repo; framework preset **Other**. `vercel.json` supplies build/output.
2. Add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_URL` (https), `NODE_ENV=production`.
3. Deploy, then check `/api/health`, register, create an org.
4. First deploy: confirm the function builds (Express app default export in `api/index.ts`).

## 3. Verifying security
* `npm run build` fails if secrets/JWTs appear in `public/`.
* `npm run test:db` proves RLS (tenant isolation, denied writes, role limits) on a real Postgres engine.
* Prefer also running the SQL against a real Supabase stack (CI job `migrations` does `supabase db reset` + re-apply).

## 4. Adding a table later
Enable RLS, grant only needed privileges to `authenticated`, add policies using `app.is_member / app.has_role`,
expose writes through SECURITY DEFINER functions, and add cases to `tests/db`.

## 5. Phase 2: storage and CSP notes
* The migrations create the private `lease-documents` bucket and its policies automatically (`supabase db push`).
* **Verify against your real project once** (the local tests use a faithful stand-in, not Supabase itself):
  register → create property/unit/tenant/tenancy/lease → upload a PDF → download it. The three Storage REST calls the server
  makes are `POST /object/upload/sign/…`, `POST /object/sign/…` and `GET /object/info/…`.
* `vercel.json` CSP allows `connect-src https://*.supabase.co` for direct uploads. Using a custom Supabase domain? Add it there.
* Supabase Storage CORS allows browser uploads by default; if you restricted it, allow your `APP_URL` origin for `PUT`.
