# Church Security Scheduler

Weekly AM/PM security post scheduler: availability, armed coverage, rotation,
medical on duty, editable duties, sanctuary map, and shareable schedule images.

Stack: Vite (vanilla JS) · Supabase (auth + Postgres + realtime) · Vercel.

## Setup

1. **Supabase**: create a project. In SQL Editor, run `supabase/schema.sql`.
   - Authentication → URL Configuration: set **Site URL** to your Vercel URL
     and add it under **Redirect URLs**.
   - Optional: Authentication → Email Templates → Magic Link, add
     `Code: {{ .Token }}` so people can type a code instead of tapping the link
     (useful when the app is installed on the home screen).
2. **Vercel**: import this repo. Add environment variables
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Supabase → Project
   Settings → API). Deploy.
3. Sign in with the admin email from `schema.sql`, then go to
   **History → Import** and pick the backup file to load existing data.
4. Add other people under **Roster → App access**.

## Notes

- Data is not stored in this repo. Only approved emails can read it (row-level security).
- `api/keepalive.js` runs daily via Vercel Cron so the free Supabase project doesn't pause.
- Use **History → Export backup** now and then.
