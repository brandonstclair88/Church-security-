import { createClient } from '@supabase/supabase-js';
import { createDb } from './db.js';
import { start, toast, esc } from './app.js';

const URL_ = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const view = document.getElementById('view');

function gate(html) { view.innerHTML = `<div class="card" style="max-width:420px;margin:24px auto;gap:12px">${html}</div>`; }

if (!URL_ || !KEY) {
  gate(`<h2 class="sec">Setup needed</h2><p class="muted">Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy.</p>`);
} else {
  const supabase = createClient(URL_, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  let started = false;

  const signOut = async () => { await supabase.auth.signOut(); location.replace(location.origin); };

  function showSignIn(sentTo) {
    gate(`
      <h2 class="sec">Sign in</h2>
      <p class="muted small" style="margin:0">Only approved emails can open the roster.</p>
      <form id="si-form" style="display:grid;gap:10px">
        <label class="field"><span>Email</span><input type="text" id="si-email" inputmode="email" autocomplete="email" autocapitalize="none" value="${esc(sentTo || '')}" required></label>
        <button class="btn primary" type="submit">${sentTo ? 'Resend sign-in email' : 'Email me a sign-in link'}</button>
      </form>
      ${sentTo ? `
      <p class="okline" style="margin:0">Check ${esc(sentTo)} and tap the link. Open it on this device.</p>
      <form id="si-code" style="display:grid;gap:10px">
        <label class="field"><span>Or enter the code from the email</span><input type="text" id="si-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></label>
        <button class="btn" type="submit">Sign in with code</button>
      </form>` : ''}`);
    document.getElementById('si-form').onsubmit = async (e) => {
      e.preventDefault();
      const email = document.getElementById('si-email').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter a valid email.'); return; }
      const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin, shouldCreateUser: true } });
      if (error) { toast(/rate|security purposes/i.test(error.message) ? 'Too many emails. Wait a minute and try again.' : 'Couldn’t send the email: ' + (error.message || error.status || 'unknown error')); return; }
      showSignIn(email);
    };
    const codeForm = document.getElementById('si-code');
    if (codeForm) codeForm.onsubmit = async (e) => {
      e.preventDefault();
      const token = document.getElementById('si-otp').value.trim();
      const { error } = await supabase.auth.verifyOtp({ email: sentTo, token, type: 'email' });
      if (error) toast('That code didn’t work. Use the newest email.');
    };
  }

  async function enter(session) {
    if (started) return;
    const email = (session.user.email || '').toLowerCase();
    view.innerHTML = '<p class="muted">Loading roster…</p>';
    const { data: role, error } = await supabase.rpc('my_role');
    if (error) { gate(`<h2 class="sec">Couldn’t connect</h2><p class="muted">Check your connection and reload.</p>`); return; }
    if (!role) {
      gate(`<h2 class="sec">Not approved yet</h2><p class="muted">${esc(email)} isn’t on the access list. Ask an admin to add it under Roster → App access.</p><button class="btn" id="so">Sign out</button>`);
      document.getElementById('so').onclick = signOut;
      return;
    }
    let db;
    try { db = await createDb(supabase, email); }
    catch { gate(`<h2 class="sec">Couldn’t load the roster</h2><p class="muted">Check your connection and reload.</p>`); return; }
    started = true;
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
    const access = {
      list: async () => { const { data, error: e } = await supabase.from('allowed_emails').select('email,role').order('email'); if (e) throw e; return data; },
      add: async (em, r) => { const { error: e } = await supabase.from('allowed_emails').upsert({ email: em, role: r }); if (e) throw e; },
      remove: async (em) => { const { error: e } = await supabase.from('allowed_emails').delete().eq('email', em); if (e) throw e; },
    };
    start({ db, email, role, access, signOut });
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (session && !started) setTimeout(() => enter(session), 0);
  });
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) enter(session);
    else if (location.hash.includes('error_description')) { showSignIn(); toast('That sign-in link expired. Request a new one.'); }
    else if (!location.hash.includes('access_token')) showSignIn();
  });
}
