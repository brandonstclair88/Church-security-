// Returns tomorrow's schedule picture (PNG) once it's marked final in the app.
// Called by an iPhone Shortcut automation (e.g. Saturdays 8:30 PM), which then
// sends the picture to the group chat. Returns an empty body when there is no
// final schedule for the upcoming Sunday, so nothing gets sent.
//
// Vercel env vars: SHORTCUT_KEY, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL.
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { buildScheduleSvg } from '../src/schedule-image.js';

const TZ = 'America/Los_Angeles';
const FONTS = [
  fileURLToPath(new URL('./_fonts/IBMPlexSans-400.ttf', import.meta.url)),
  fileURLToPath(new URL('./_fonts/IBMPlexSans-700.ttf', import.meta.url)),
];

function upcomingSunday(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.SHORTCUT_KEY || '';
  const given = String((req.query && req.query.key) || '');
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(401).send('');
  }
  const base = String(process.env.VITE_SUPABASE_URL || '').trim().replace(/\/(rest|auth)\/v1.*$/, '').replace(/\/+$/, '');
  const svc = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !svc) return res.status(500).send('');
  const headers = { apikey: svc };
  if (svc.startsWith('eyJ')) headers.Authorization = `Bearer ${svc}`;

  try {
    const week = String((req.query && req.query.week) || '') .match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.week : upcomingSunday();
    const wr = await fetch(`${base}/rest/v1/docs?path=eq.weeks/${week}&select=data`, { headers });
    if (!wr.ok) return res.status(502).send('');
    const w = ((await wr.json())[0] || {}).data;
    const hasSched = w && w.sched && Object.values(w.sched).some((s) => s && Object.values(s).some(Boolean));
    if (!w || !w.final || !hasSched) return res.status(200).send(''); // nothing final to send

    const dr = await fetch(`${base}/rest/v1/docs?coll=in.(members,medics,posts,settings)&select=path,doc_id,coll,data`, { headers });
    if (!dr.ok) return res.status(502).send('');
    const rows = await dr.json();
    const list = (c) => rows.filter((r) => r.coll === c).map((r) => ({ id: r.doc_id, ...r.data }));
    const map = (rows.find((r) => r.path === 'settings/map') || {}).data;

    const { svg } = buildScheduleSvg({ week: { ...w, date: week }, members: list('members'), medics: list('medics'), posts: list('posts'), layout: map });
    const png = new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' } }).render().asPng();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="security-schedule-${week}.png"`);
    return res.status(200).send(Buffer.from(png));
  } catch {
    return res.status(502).send('');
  }
}
