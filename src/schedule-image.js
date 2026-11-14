// Builds the shareable schedule picture as SVG. Shared by the app (Share
// schedule button) and the server (automatic Saturday-night message).
// Pure: takes data in, returns an SVG string. No browser globals.

export const VB = { w: 380, h: 334 };
export const DEFAULT_LAYOUT={v:2,shapes:[
  {id:'room',kind:'room',mirror:'self',pts:[[30,70],[125,40],[255,40],[350,70],[282,298],[98,298]]},
  {id:'stage',kind:'stage',label:'Stage',mirror:'self',pts:[[125,40],[255,40],[255,74],[190,94],[125,74]]},
  {id:'piano',kind:'fixture',label:'Piano',pts:[[224,46],[244,46],[244,59],[224,59]]},
  {id:'pulpit',kind:'fixture',label:'Pulpit',mirror:'self',pts:[[184,78],[196,78],[196,86],[184,86]]},
  {id:'s1',kind:'section',mirror:'s4',pts:[[42,100],[100,104],[92,208],[74,208]]},
  {id:'s4',kind:'section',mirror:'s1',pts:[[338,100],[280,104],[288,208],[306,208]]},
  {id:'s2',kind:'section',mirror:'s3',pts:[[110,104],[182,102],[182,210],[102,212]]},
  {id:'s3',kind:'section',mirror:'s2',pts:[[270,104],[198,102],[198,210],[278,212]]},
  {id:'s5',kind:'section',mirror:'s6',pts:[[86,226],[182,224],[182,288],[104,290]]},
  {id:'s6',kind:'section',mirror:'s5',pts:[[294,226],[198,224],[198,288],[276,290]]},
  {id:'booth',kind:'fixture',label:'Sound booth',pts:[[248,274],[272,274],[272,286],[248,286]]},
  {id:'d1',kind:'door',label:'Left door',mirror:'d2',pts:[[72,211],[76,224]]},
  {id:'d2',kind:'door',label:'Right door',mirror:'d1',pts:[[308,211],[304,224]]},
  {id:'d3',kind:'door',label:'Front right door',pts:[[347,78],[343,92]]},
  {id:'d4',kind:'door',label:'Rear door',mirror:'self',pts:[[181,298],[199,298]]}]};

const SVCS = ['AM', 'PM'];
const SVC_NAME = { AM: 'Morning', PM: 'Evening' };
const COL = { bg: '#FFFFFF', room: '#F3F5F2', wall: '#56655C', sec: '#DDE4DE', secLine: '#BFC9C1', door: '#7D5210', mk: '#2B5C4C', mkEmpty: '#9E3B18', ink: '#17211C', muted: '#4A5850', chip: '#E1E7E2', rule: '#D5DDD7' };
const F = "'IBM Plex Sans', Helvetica, Arial, sans-serif";
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ptsStr = (s) => s.pts.map((p) => p[0] + ',' + p[1]).join(' ');
const centroid = (s) => { const n = s.pts.length; return [s.pts.reduce((a, p) => a + p[0], 0) / n, s.pts.reduce((a, p) => a + p[1], 0) / n]; };
const label = (p) => (p.seat ? '(' + p.code + ')' : p.code);
function wrapText(t, max) {
  const words = String(t).split(/\s+/).filter(Boolean), out = []; let line = '';
  words.forEach((w) => { if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; } else line = (line ? line + ' ' : '') + w; });
  if (line) out.push(line); return out;
}
function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function buildScheduleSvg({ week, members, medics, posts, layout }) {
  const w = week || {};
  const L = layout && layout.v === 2 && Array.isArray(layout.shapes) ? layout : DEFAULT_LAYOUT;
  const mm = {}; (members || []).forEach((m) => { mm[m.id] = m; });
  const allPosts = [...(posts || [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const postsFor = (svc) => allPosts.filter((p) => (p.services || []).includes(svc));
  const medicName = (svc) => { const id = w.med && w.med[svc]; const m = id && (medics || []).find((x) => x.id === id); return m ? m.name : ''; };
  const DEF = { '1': [76, 154], '2': [144, 156], '3': [236, 156], '4': [304, 154], '5': [140, 257], '6': [240, 257] };
  const order = ['room', 'stage', 'section', 'fixture', 'door'];
  const shapes = [...L.shapes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const drawShapes = shapes.map((sh) => {
    const pts = ptsStr(sh);
    if (sh.kind === 'door') return `<polyline points="${pts}" fill="none" stroke="${COL.door}" stroke-width="4" stroke-linecap="round"/>`;
    const st = sh.kind === 'room' ? `fill="${COL.room}" stroke="${COL.wall}" stroke-width="1.5"`
      : sh.kind === 'fixture' ? `fill="none" stroke="${COL.wall}" stroke-width="1"`
      : `fill="${COL.sec}" stroke="${COL.secLine}" stroke-width="${sh.kind === 'stage' ? 1 : 0.5}"`;
    const c = centroid(sh);
    const lbl = sh.label && (sh.kind === 'stage' || sh.kind === 'section') ? `<text x="${c[0].toFixed(0)}" y="${(c[1] + 3.5).toFixed(0)}" text-anchor="middle" font-family="${F}" font-size="10" font-weight="700" letter-spacing="2" fill="${COL.muted}">${esc(String(sh.label).toUpperCase())}</text>` : '';
    return `<polygon points="${pts}" ${st}/>${lbl}`;
  }).join('');
  const svcs = SVCS.filter((sv) => postsFor(sv).length && Object.values((w.sched && w.sched[sv]) || {}).some(Boolean));
  let y = 0, out = '';
  const T = (x, yy, txt, size, weight, fill, anchor) => `<text x="${x}" y="${yy}" font-family="${F}" font-size="${size}" font-weight="${weight || 400}" fill="${fill || COL.ink}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(txt)}</text>`;
  const rule = () => { y += 10; out += `<line x1="16" y1="${y}" x2="${VB.w - 16}" y2="${y}" stroke="${COL.rule}" stroke-width="0.5"/>`; y += 18; };
  const chip = (t) => `<rect x="16" y="${y - 13}" width="34" height="18" rx="4" fill="${COL.chip}"/>` + T(33, y, t, 11, 700, COL.ink, 'middle');
  y += 26; out += T(16, y, 'Security posts · ' + fmtDate(w.date), 16, 700); y += 8;
  svcs.forEach((svc) => {
    const sched = (w.sched && w.sched[svc]) || {}, ps = postsFor(svc);
    y += 24; out += `<rect x="0" y="${y - 17}" width="${VB.w}" height="24" fill="${COL.chip}"/>` + T(16, y, SVC_NAME[svc] + ' service (' + svc + ')', 14, 700);
    y += 8;
    const seats = ps.filter((p) => p.seat);
    if (seats.length) {
      const mk = seats.map((p) => {
        const d = DEF[p.code] || [190, 160]; const x = p.x ?? d[0], yy = p.y ?? d[1]; const m = mm[sched[p.id]];
        const nm = esc(m ? m.name : 'Open');
        return `<g transform="translate(${x} ${yy})"><circle r="13" fill="${m ? COL.mk : COL.mkEmpty}" stroke="#FFFFFF" stroke-width="2"/><text text-anchor="middle" y="4.5" font-family="${F}" font-size="12" font-weight="700" fill="#FFFFFF">${esc(p.code)}</text><text text-anchor="middle" y="28" font-family="${F}" font-size="11" font-weight="700" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="3.5" stroke-linejoin="round">${nm}</text><text text-anchor="middle" y="28" font-family="${F}" font-size="11" font-weight="700" fill="${COL.ink}">${nm}</text></g>`;
      }).join('');
      let maxY = 0; L.shapes.forEach((sh) => sh.pts.forEach((q) => { if (q[1] > maxY) maxY = q[1]; }));
      seats.forEach((p) => { const d = DEF[p.code] || [190, 160]; const yy = (p.y ?? d[1]) + 32; if (yy > maxY) maxY = yy; });
      out += `<g transform="translate(0 ${y})">${drawShapes}${mk}</g>`; y += Math.min(VB.h, maxY + 6);
    }
    ps.forEach((p) => { const m = mm[sched[p.id]]; rule(); out += chip(label(p)) + T(58, y, m ? m.name : 'Open', 13, 700, m ? COL.ink : COL.mkEmpty); });
    const md = medicName(svc);
    if (md) { rule(); out += chip('Med') + T(58, y, md, 13, 700); }
    const used = new Set(Object.values(sched));
    const off = (members || []).filter((mb) => mb.active !== false && w.avail && w.avail[mb.id] && w.avail[mb.id][svc] && !used.has(mb.id));
    if (off.length) { rule(); out += chip('OFF'); wrapText(off.map((mb) => mb.name).join(', '), 48).forEach((ln, k) => { if (k) y += 15; out += T(58, y, ln, 12, 400); }); }
    y += 12;
  });
  y += 16;
  const H = Math.ceil(y), SC = 3;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${VB.w * SC}" height="${H * SC}" viewBox="0 0 ${VB.w} ${H}"><rect width="${VB.w}" height="${H}" fill="${COL.bg}"/>${out}</svg>`, count: svcs.length };
}
