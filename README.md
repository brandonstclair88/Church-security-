# Church Security Scheduler

Weekly AM/PM security post scheduler: availability, armed coverage, rotation,
medical on duty, editable duties, sanctuary map, and shareable schedule images.

Stack: Vite (vanilla JS) · Supabase (auth + Postgres + realtime) · Vercel.

## Setup

1. **Supabase**: create a project. In SQL Editor, run `supabase/schema.sql`,
   then `supabase/03_availability_links.sql`.
   - Authentication → URL Configuration: set **Site URL** to your Vercel URL
     and add it under **Redirect URLs**.
   - People sign in with email + password. The first time, they tap
     "Create your password" and confirm their email once.
2. **Vercel**: import this repo. Add environment variables
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Supabase → Project
   Settings → API). Deploy.
3. Create your password with the admin email from `schema.sql`, sign in, then go to
   **History → Import** and pick the backup file to load existing data.
4. Add other people under **Roster → App access**.

## Notes

- Weekly availability: on the Sunday tab, create the group chat link and paste the
  message into the chat. People tap their name and pick AM/PM; no sign-in.

- Data is not stored in this repo. Only approved emails can read it (row-level security).
- `api/keepalive.js` runs daily via Vercel Cron so the free Supabase project doesn't pause.
- Use **History → Export backup** now and then.

## Automatic weekly group chat message (iPhone Shortcut)

`/api/weekly-message?key=SHORTCUT_KEY` returns this Sunday's availability message
(and creates the link if needed). It returns nothing while the group chat link is
turned off in the app (Roster tab).

Vercel env vars: `SHORTCUT_KEY` (long random string) and `SUPABASE_SERVICE_ROLE_KEY`
(Supabase secret key). Redeploy after adding them.

On the sending iPhone: Shortcuts → Automation → New → Time of Day (Saturday 9:00 AM,
Weekly, Run Immediately) → actions: Get Contents of URL (the address above) →
If "Contents of URL" has any value → Send Message (Contents of URL) to the group.
