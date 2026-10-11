# AI Asis Phase 2: setup (Supabase + Vercel + GitHub)

## 1. Supabase project
1. Create a project at supabase.com. Copy **Project URL** and the **anon / publishable key** (Project Settings > API).
2. Run the 3 files in `supabase/migrations/` in order, either:
   - SQL Editor: paste and run `...0001_schema.sql`, then `...0002_rls.sql`, then `...0003_storage.sql`; or
   - Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
3. Authentication > URL Configuration:
   - **Site URL**: your production URL (e.g. `https://your-app.vercel.app`).
   - **Redirect URLs**: add `https://your-app.vercel.app/auth/callback`, `http://localhost:3000/auth/callback`, and for Vercel previews `https://*-<your-team>.vercel.app/auth/callback`.
4. Authentication > Providers > Email: keep "Confirm email" on for production. Set minimum password length to 8 or more.
5. Check Storage: bucket `invoices` must exist and be **private**.

## 2. Google login (optional)
1. Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application).
2. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase > Authentication > Providers > Google: paste Client ID and Secret, enable.
4. Set `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true`. Without this the Google button stays hidden.

## 3. Local run
```bash
cp .env.example .env.local   # fill in your values
npm install
npm run dev
npm test                     # unit tests (needs Node 22.6+)
npm run typecheck && npm run lint && npm run build
```

## 4. Vercel + GitHub
1. Push the project to GitHub (`.env.local` is git-ignored).
2. Vercel > Add New Project > import the repo.
3. Environment Variables (Production and Preview): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` (production domain), `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED`.
4. Deploy. Do **not** add the service-role key anywhere in Phase 2; it is not used.

## Security model (short)
- Every table has RLS enabled. Access is by firm membership (`firm_members`), checked in policies via `is_firm_member()`.
- Child tables carry `firm_id` with composite foreign keys, so a row can never point at another firm's invoice or client.
- Storage paths are `<firm_id>/<invoice_id>.<ext>`; storage policies check the firm in the path. Files are only served through 60-second signed URLs created after an authorization check.
- Uploads: server route validates size and real file type (magic bytes), ignores the browser MIME type, and never puts user filenames in paths. Same-origin check on POST/DELETE.
- Deletion: mark `pending_deletion` -> delete storage file -> delete row. If the file removal fails, the row stays marked so you can retry.
- Logs contain only ids and error codes, never invoice content, emails or passwords.

## Known limits
- **4 MB per file**: Vercel Functions reject request bodies over 4.5 MB. Larger files need signed direct-to-storage uploads (can be added later).
- One firm per user for now (a personal firm is created at signup). Team invites come later and will be server-side.
- No rate limiting or malware scanning yet.
- `usage_records`, `processing_jobs`, `export_history`, `extracted_data`, `line_items`, `clients` are created and protected, but nothing writes to them yet (Phase 3+).
- Email confirmation and reset links must be opened in the same browser where you requested them (PKCE).
