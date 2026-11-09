import { createClient } from '@supabase/supabase-js';
import { createDb } from './db.js';
import { start, toast, esc } from './app.js';
import { renderPublic } from './public.js';

const URL_ = String(import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/(rest|auth)\/v1.*$/, '').replace(/\/+$/, '');
const KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim().replace(/^["']|["']$/g, '');
const view = document.getElementById('view');

function gate(html) { view.innerHTML = `<div class="card" style="max-width:420px;margin:24px auto;gap:12px">${html}</div>`; }

if (!URL_ || !KEY) {
  gate(`<h2 class="sec">Setup needed</h2><p class="muted">Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy.</p>`);
} else {
  const supabase = createClient(URL_, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  let started = false;
  const availToken = new URLSearchParams(location.search).get('a');

  const signOut = async () => { await supabase.auth.signOut(); location.replace(location.origin); };

  const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  function authError(error) {
    const m = String((error && error.message) || '');
    if (/Database error saving new user|not approved/i.test(m)) return 'That email isn’t approved yet. Ask an admin to add it under Roster → App access.';
    if (/Invalid login credentials/i.test(m)) return 'Wrong email or password. First time here? Tap “Create your password.”';
    if (/Email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the confirmation link.';
    if (/already registered|already been registered/i.test(m)) return 'That email already has a password. Sign in, or tap “Forgot password?”';
    if (/rate|security purposes/i.test(m)) return 'Too many tries. Wait a minute and try again.';
    if (/Password should be/i.test(m)) return 'Use a longer password (at least 8 characters).';
    return 'Something went wrong: ' + (m || 'unknown error');
  }
  const emailField = (v) => `<label class="field"><span>Email</span><input type="text" id="si-email" inputmode="email" autocomplete="username" autocapitalize="none" value="${esc(v || '')}"></label>`;
  const links = (items) => `<div class="actions" style="justify-content:space-between">${items.map(([m, t]) => `<button class="req-btn" type="button" data-mode="${m}">${t}</button>`).join('')}</div>`;
  function bindLinks() { view.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => showSignIn(b.dataset.mode, (document.getElementById('si-email') || {}).value); }); }

  function showSignIn(mode = 'signin', email = '', note = '') {
    const noteHtml = note ? `<p class="okline" style="margin:0">${esc(note)}</p>` : '';
    if (mode === 'signin') {
      gate(`<h2 class="sec">Sign in</h2>${noteHtml}
        <form id="si-form" style="display:grid;gap:10px">${emailField(email)}
          <label class="field"><span>Password</span><input type="password" id="si-pw" autocomplete="current-password"></label>
          <button class="btn primary" type="submit">Sign in</button></form>
        ${links([['create', 'First time? Create your password'], ['forgot', 'Forgot password?']])}`);
      bindLinks();
      document.getElementById('si-form').onsubmit = async (e) => {
        e.preventDefault();
        const em = document.getElementById('si-email').value.trim().toLowerCase(), pw = document.getElementById('si-pw').value;
        if (!validEmail(em) || !pw) { toast('Enter your email and password.'); return; }
        const { error } = await supabase.auth.signInWithPassword({ email: em, password: pw });
        if (error) toast(authError(error));
      };
    } else if (mode === 'create') {
      gate(`<h2 class="sec">Create your password</h2>
        <p class="muted small" style="margin:0">Your email must already be on the team’s approved list.</p>
        <form id="si-form" style="display:grid;gap:10px">${emailField(email)}
          <label class="field"><span>New password (8+ characters)</span><input type="password" id="si-pw" autocomplete="new-password"></label>
          <label class="field"><span>Confirm password</span><input type="password" id="si-pw2" autocomplete="new-password"></label>
          <button class="btn primary" type="submit">Create account</button></form>
        ${links([['signin', 'Back to sign in']])}`);
      bindLinks();
      document.getElementById('si-form').onsubmit = async (e) => {
        e.preventDefault();
        const em = document.getElementById('si-email').value.trim().toLowerCase();
        const pw = document.getElementById('si-pw').value, pw2 = document.getElementById('si-pw2').value;
        if (!validEmail(em)) { toast('Enter a valid email.'); return; }
        if (pw.length < 8) { toast('Use at least 8 characters.'); return; }
        if (pw !== pw2) { toast('The passwords don’t match.'); return; }
        const { data, error } = await supabase.auth.signUp({ email: em, password: pw, options: { emailRedirectTo: location.origin } });
        if (error) { toast(authError(error)); return; }
        if (data.session) return; // confirmation turned off: signed in already
        showSignIn('signin', em, 'Almost done. Tap the confirmation link we emailed you (it can open anywhere), then sign in here with your password.');
      };
    } else if (mode === 'forgot') {
      gate(`<h2 class="sec">Reset password</h2>
        <form id="si-form" style="display:grid;gap:10px">${emailField(email)}
          <button class="btn primary" type="submit">Email me a reset link</button></form>
        ${links([['signin', 'Back to sign in']])}`);
      bindLinks();
      document.getElementById('si-form').onsubmit = async (e) => {
        e.preventDefault();
        const em = document.getElementById('si-email').value.trim().toLowerCase();
        if (!validEmail(em)) { toast('Enter a valid email.'); return; }
        const { error } = await supabase.auth.resetPasswordForEmail(em, { redirectTo: location.origin });
        if (error) { toast(authError(error)); return; }
        showSignIn('signin', em, 'If that email has an account, a reset link is on its way. Open it, set a new password, then sign in.');
      };
    } else if (mode === 'newpw') {
      gate(`<h2 class="sec">Set a new password</h2>
        <form id="si-form" style="display:grid;gap:10px">
          <label class="field"><span>New password (8+ characters)</span><input type="password" id="si-pw" autocomplete="new-password"></label>
          <label class="field"><span>Confirm password</span><input type="password" id="si-pw2" autocomplete="new-password"></label>
          <button class="btn primary" type="submit">Save password</button></form>`);
      document.getElementById('si-form').onsubmit = async (e) => {
        e.preventDefault();
        const pw = document.getElementById('si-pw').value, pw2 = document.getElementById('si-pw2').value;
        if (pw.length < 8) { toast('Use at least 8 characters.'); return; }
        if (pw !== pw2) { toast('The passwords don’t match.'); return; }
        const { data, error } = await supabase.auth.updateUser({ password: pw });
        if (error) { toast(authError(error)); return; }
        recovering = false; toast('Password saved.');
        const { data: { session } } = await supabase.auth.getSession();
        if (session) enter(session); else showSignIn('signin', (data.user && data.user.email) || '');
      };
    }
  }
  let recovering = /type=recovery/.test(location.hash);

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
    const randomToken = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); return Array.from(a, (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[b % 56]).join(''); };
    const links = {
      get: async (week) => {
        const { data, error: e } = await supabase.from('avail_links').select('token').eq('week', week).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1);
        if (e) throw e; return data && data[0] ? data[0].token : null;
      },
      create: async (week) => {
        const [y, m, d] = week.split('-').map(Number);
        const expires = new Date(y, m - 1, d + 1, 12).toISOString();
        const token = randomToken();
        const { error: e } = await supabase.from('avail_links').insert({ token, week, expires_at: expires, created_by: email });
        if (e) throw e; return token;
      },
    };
    start({ db, email, role, access, signOut, links });
  }

  if (availToken) {
    renderPublic(supabase, availToken, toast);
  } else {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; setTimeout(() => showSignIn('newpw'), 0); return; }
    if (event === 'SIGNED_OUT') { started = false; showSignIn('signin'); return; }
    if (session && !started && !recovering) setTimeout(() => enter(session), 0);
  });
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (recovering) { showSignIn('newpw'); return; }
    if (session) enter(session);
    else if (/error_description/.test(location.hash)) { showSignIn('signin', '', 'That link expired or was already used. Sign in with your password, or tap “Forgot password?”'); history.replaceState(null, '', location.pathname); }
    else if (!location.hash.includes('access_token')) showSignIn('signin');
  });
  }
}
