// Public availability page: opened from the weekly group chat link (/?a=TOKEN).
// No sign-in. Shows only names. Reads and writes through two database
// functions that check the link is valid and not expired.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHOICES = [
  { key: 'both', label: 'Both services', am: true, pm: true },
  { key: 'am', label: 'Morning only', am: true, pm: false },
  { key: 'pm', label: 'Evening only', am: false, pm: true },
  { key: 'out', label: 'Can’t make it', am: false, pm: false },
];
const ME_KEY = 'security-avail-me';
const getMe = () => { try { return localStorage.getItem(ME_KEY) || ''; } catch { return ''; } };
const setMe = (v) => { try { v ? localStorage.setItem(ME_KEY, v) : localStorage.removeItem(ME_KEY); } catch { /* private mode */ } };

function status(a) {
  if (!a || !a.answered) return { text: 'No reply', cls: '' };
  if (a.AM && a.PM) return { text: 'AM + PM', cls: 'med' };
  if (a.AM) return { text: 'AM', cls: 'med' };
  if (a.PM) return { text: 'PM', cls: 'med' };
  return { text: 'Out', cls: '' };
}
function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export async function renderPublic(supabase, token, toast) {
  const view = document.getElementById('view');
  const tabs = document.getElementById('tabs'); if (tabs) tabs.hidden = true;
  let info = null;
  let picked = '';

  async function load() {
    const { data, error } = await supabase.rpc('avail_get', { p_token: token });
    if (error) throw error;
    info = data;
  }

  function requestHtml(me) {
    const a = (info.avail || {})[me.id];
    const posts = info.posts || [];
    if (!a || !a.answered || !(a.AM || a.PM) || !posts.length) return '';
    const sel = (svc, label) => {
      if (!a[svc]) return '';
      const ps = posts.filter((p) => (p.services || []).includes(svc));
      if (!ps.length) return '';
      const cur = a['req' + svc] || '';
      return `<label class="field"><span>${label}</span><select data-pubreq="${svc}"><option value="">No preference</option>${ps.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(/^\d+$/.test(p.code) ? '(' + p.code + ')' : p.code)}${p.name ? ' · ' + esc(p.name) : ''}</option>`).join('')}</select></label>`;
    };
    return `<div class="card" style="gap:10px"><strong>Request a specific post (optional)</strong>
      ${sel('AM', 'Morning')}${sel('PM', 'Evening')}
      <p class="hint" style="margin:0">Requests are filled when possible.</p></div>`;
  }

  function draw() {
    if (!info) {
      view.innerHTML = `<div class="empty"><h3>This link has expired</h3><p>Ask in the group chat for this week’s availability link.</p></div>`;
      return;
    }
    const members = info.members || [];
    const avail = info.avail || {};
    const me = members.find((m) => m.id === picked);
    const head = `<div style="display:grid;gap:4px"><h2 class="sec">${esc(fmtDate(info.week))}</h2><p class="muted" style="margin:0">${me ? 'When can you serve?' : 'Tap your name, then choose when you can serve.'}</p></div>`;
    if (me) {
      const cur = status(avail[me.id]);
      view.innerHTML = `${head}
        <div class="card" style="gap:12px">
          <div class="sec-head"><strong style="font-size:17px">${esc(me.name)}</strong><button class="req-btn" data-pub="notme">Not you?</button></div>
          <div style="display:grid;gap:8px">${CHOICES.map((c) => `<button class="btn${c.key === 'out' ? '' : ' primary'}" style="min-height:52px;font-size:16px" data-pub="choose" data-v="${c.key}">${c.label}</button>`).join('')}</div>
          <p class="hint" style="margin:0">Current answer: <strong>${esc(cur.text)}</strong>. You can change it any time before Sunday.</p>
        </div>
        ${requestHtml(me)}
        <button class="btn block" data-pub="list">See everyone’s replies</button>`;
    } else {
      const replied = members.filter((m) => avail[m.id] && avail[m.id].answered).length;
      view.innerHTML = `${head}
        <ul class="list">${members.map((m) => { const st = status(avail[m.id]);
          return `<li><button class="row tap" data-pub="pick" data-v="${esc(m.id)}"><span class="main"><span class="name">${esc(m.name)}</span></span><span class="tag ${st.cls}">${esc(st.text)}</span><span class="muted" aria-hidden="true">›</span></button></li>`; }).join('')}</ul>
        <p class="hint">${replied} of ${members.length} replied. Not on the list? Reply in the group chat instead.</p>`;
    }
  }

  view.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-pubreq]'); if (!el || !picked) return;
    el.disabled = true;
    const { data, error } = await supabase.rpc('avail_request', { p_token: token, p_member: picked, p_svc: el.dataset.pubreq, p_post: el.value || null });
    if (error || !data) toast(error ? 'Couldn’t save the request. Try again.' : 'Couldn’t save the request. Pick your availability first.');
    else toast(el.value ? 'Request saved.' : 'Request cleared.');
    try { await load(); } catch { /* keep view */ }
    draw();
  });

  view.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-pub]'); if (!el) return;
    const act = el.dataset.pub;
    if (act === 'pick') { picked = el.dataset.v; setMe(picked); draw(); scrollTo(0, 0); }
    else if (act === 'notme') { picked = ''; setMe(''); draw(); }
    else if (act === 'list') { picked = ''; draw(); }
    else if (act === 'choose') {
      const c = CHOICES.find((x) => x.key === el.dataset.v); if (!c || !picked) return;
      view.querySelectorAll('[data-pub="choose"]').forEach((b) => { b.disabled = true; });
      const { data, error } = await supabase.rpc('avail_set', { p_token: token, p_member: picked, p_am: c.am, p_pm: c.pm });
      if (error || !data) { toast(error ? 'Couldn’t save. Check your connection and try again.' : 'This link has expired.'); }
      else {
        const name = ((info.members || []).find((m) => m.id === picked) || {}).name || '';
        toast(`Thanks${name ? ', ' + name : ''}. Saved: ${c.label.toLowerCase()}.`);
      }
      try { await load(); } catch { /* keep current view */ }
      draw();
    }
  });

  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await load(); } catch { view.innerHTML = `<div class="empty"><h3>Couldn’t load</h3><p>Check your connection and reload.</p></div>`; return; }
  const saved = getMe();
  if (info && (info.members || []).some((m) => m.id === saved)) picked = saved;
  draw();
}
