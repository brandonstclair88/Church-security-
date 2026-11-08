// Called once a day by a Vercel cron so the free Supabase project never
// counts as inactive (free projects pause after a week without requests).
export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });
  try {
    const r = await fetch(`${url}/rest/v1/allowed_emails?select=email&limit=1`, {
      headers: { apikey: key },
    });
    return res.status(200).json({ ok: r.ok, status: r.status, at: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
