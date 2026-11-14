// Returns this week's group chat availability message as plain text.
// Called by an iPhone Shortcut automation (e.g. Saturdays 9:00 AM), which then
// sends the text to the group chat. Creates the week's link if needed.
// Returns an empty body when the group chat link is turned off in the app.
//
// Vercel env vars: SHORTCUT_KEY (any long random string, also used in the
// Shortcut URL), SUPABASE_SERVICE_ROLE_KEY (Supabase secret key, server only),
// VITE_SUPABASE_URL (already set). Optional: SITE_URL.
import crypto from 'node:crypto';

const TZ = 'America/Los_Angeles';
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function upcomingSunday(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now); // YYYY-MM-DD
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
function token() {
  return Array.from(crypto.randomBytes(18), (b) => CHARS[b % CHARS.length]).join('');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const debug = req.query && req.query.debug === '1';
  const say = (code, why) => { if (debug) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(code).send(why); } return res.status(code).send(''); };
  const key = process.env.SHORTCUT_KEY || '';
  const given = String((req.query && req.query.key) || '');
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return say(401, 'The key in the address doesn’t match SHORTCUT_KEY in Vercel (or SHORTCUT_KEY isn’t set).');
  }
  const base = String(process.env.VITE_SUPABASE_URL || '').trim().replace(/\/(rest|auth)\/v1.*$/, '').replace(/\/+$/, '');
  const svc = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !svc) return say(500, !svc ? 'SUPABASE_SERVICE_ROLE_KEY isn’t set in Vercel (add it, then redeploy).' : 'VITE_SUPABASE_URL isn’t set in Vercel.');
  const headers = { apikey: svc, 'Content-Type': 'application/json' };
  if (svc.startsWith('eyJ')) headers.Authorization = `Bearer ${svc}`;
  const site = String(process.env.SITE_URL || 'https://church-security-dun.vercel.app').replace(/\/+$/, '');

  try {
    const s = await fetch(`${base}/rest/v1/docs?path=eq.settings/team&select=data`, { headers });
    if (!s.ok) return say(502, 'Supabase refused the request (' + s.status + '). Check that SUPABASE_SERVICE_ROLE_KEY is the secret key, not the publishable one.');
    const rows = await s.json();
    if (!(rows[0] && rows[0].data && rows[0].data.availLink)) return say(200, 'The group chat link is turned off in the app (Roster tab), so nothing is sent.');

    const week = upcomingSunday();
    const nowIso = new Date().toISOString();
    const f = await fetch(`${base}/rest/v1/avail_links?week=eq.${week}&expires_at=gt.${encodeURIComponent(nowIso)}&select=token&order=created_at.desc&limit=1`, { headers });
    if (!f.ok) return say(502, 'Supabase refused the request (' + f.status + '). Check that SUPABASE_SERVICE_ROLE_KEY is the secret key, not the publishable one.');
    let t = ((await f.json())[0] || {}).token;
    if (!t) {
      t = token();
      const exp = new Date(week + 'T12:00:00Z'); exp.setUTCDate(exp.getUTCDate() + 1); exp.setUTCHours(20);
      const ins = await fetch(`${base}/rest/v1/avail_links`, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ token: t, week, expires_at: exp.toISOString(), created_by: 'weekly shortcut' }) });
      if (!ins.ok) return say(502, 'Supabase refused the request (' + ins.status + '). Check that SUPABASE_SERVICE_ROLE_KEY is the secret key, not the publishable one.');
    }
    const when = new Date(week + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(`Who's available for security on ${when}? Tap your name and pick AM, PM, both, or out:\n${site}/?a=${encodeURIComponent(t)}`);
  } catch (e) {
    return say(502, 'Error: ' + (e && e.message ? e.message : String(e)));
  }
}
