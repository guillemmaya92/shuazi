/* Profile page: progress stats + account (sign in). Reads progress from the same
   localStorage key and Supabase tables as the app, so it stays in sync. */
(() => {
  const SUPA_URL = 'https://coysmojauucqgdhhxyrz.supabase.co';
  const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNveXNtb2phdXVjcWdkaGh4eXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODAxOTMsImV4cCI6MjA5Njk1NjE5M30.JO6U0TyW5gcnmJMJAvvzSh_ZiMdCKCEtRSz_N8h8adM';
  const STORE_KEY = 'shuazi-v1';
  const STRIPE_PRICE = 'price_1TlomiBbC7zMbLYpULYnfvr1';
  const BUBBLE_PRICE = 2;
  const DATA = window.__SHUAZI_DATA__ || { c: [], w: [] };

  // rows: [id, name, hsk, frequency×1e6]
  const idName = { char: {}, word: {} };
  DATA.c.forEach(r => { idName.char[r[0]] = r[1]; });
  DATA.w.forEach(r => { idName.word[r[0]] = r[1]; });

  const known = new Set(), review = new Set();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) {}
  (saved.known   || []).forEach(x => known.add(x));
  (saved.unknown || []).forEach(x => review.add(x));
  function persistLocal() {
    saved = { ...saved, known: [...known], unknown: [...review] };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) {}
  }

  // ── Game selection (shared with the app via 'shuazi-settings') ──
  let game = 'characters';
  try { const s = JSON.parse(localStorage.getItem('shuazi-settings') || '{}'); if (s.game === 'words') game = 'words'; } catch (e) {}
  function persistGame() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('shuazi-settings') || '{}') || {}; } catch (e) {}
    s.game = game;
    try { localStorage.setItem('shuazi-settings', JSON.stringify(s)); } catch (e) {}
  }

  // ── Progress (single mode, like the app) ──
  function progressFor() {
    const rows = game === 'words' ? DATA.w : DATA.c;
    let nKnown = 0, nReview = 0, cov = 0;
    for (const [, name, , c] of rows) {
      if (known.has(name)) { nKnown++; cov += c; }
      else if (review.has(name)) nReview++;
    }
    return { total: rows.length, nKnown, nReview, nLeft: rows.length - nKnown - nReview,
             pct: Math.min(100, Math.round(cov / 1e6 * 100)) };
  }

  function renderProgress() {
    const root = document.getElementById('progRoot');
    if (!root) return;
    const s = progressFor();
    const hint = game === 'words'
      ? 'of typical Chinese text — Top 1000 words cover 75%. Mark words as learned to see your progress.'
      : 'of typical Chinese text — Top 500 chars cover 75%. Mark characters as learned to see your progress.';
    root.innerHTML = `
      <div class="prog-stats3">
        <div class="stat"><div class="stat-lbl">Known</div><div class="stat-n known">${s.nKnown.toLocaleString('en-US')}</div></div>
        <div class="stat"><div class="stat-lbl">Review</div><div class="stat-n review">${s.nReview.toLocaleString('en-US')}</div></div>
        <div class="stat"><div class="stat-lbl">Left</div><div class="stat-n">${s.nLeft.toLocaleString('en-US')}</div></div>
      </div>
      <div class="overall">
        <div class="overall-head"><span class="lbl">Overall progress</span><span class="lbl">${s.pct}%</span></div>
        <div class="prog-bar"><div class="prog-fill" style="width:${s.pct}%"></div></div>
        <p class="prog-cap">${hint}</p>
      </div>`;
  }
  const render = renderProgress;   // alias used by loadRemote

  // Game pills
  const gamePills = document.getElementById('gamePills');
  function syncPills() { gamePills?.querySelectorAll('.game-pill').forEach(b => b.classList.toggle('on', b.dataset.game === game)); }
  gamePills?.querySelectorAll('.game-pill').forEach(b => b.addEventListener('click', () => {
    game = b.dataset.game; syncPills(); persistGame(); renderProgress();
  }));
  syncPills();
  renderProgress();

  // ── Account / Supabase ──
  let supa = null, user = null, plan = 'free';
  const box = document.getElementById('accountBox');

  const GOOGLE_ICON = '<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.7-.4-3.9H24v7.1h12.1c-.2 1.8-1.6 4.6-4.5 6.4l6.6 5.1c4-3.7 6.9-9.1 6.9-14.7z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.6-5.1c-1.8 1.2-4.2 2.1-7.9 2.1-6 0-11.1-4-12.9-9.5l-6.8 5.3C7.6 40.9 15.2 46 24 46z"/><path fill="#FBBC05" d="M11.1 28.2c-.5-1.4-.7-2.8-.7-4.2s.3-2.9.7-4.2l-6.8-5.3C2.8 17.2 2 20.5 2 24s.8 6.8 2.3 9.5l6.8-5.3z"/><path fill="#EA4335" d="M24 10.3c3.4 0 5.6 1.5 6.9 2.7l5.8-5.7C33.1 4 28.9 2 24 2 15.2 2 7.6 7.1 4.3 14.5l6.8 5.3C12.9 14.3 18 10.3 24 10.3z"/></svg>';

  function renderAccount() {
    if (!box) return;
    if (user) {
      box.innerHTML = `<div class="auth-bar">
        <span class="auth-status"><span class="auth-pre">Signed in as </span><b>${esc(user.email || 'your account')}</b><span class="auth-extra"> · progress syncs with the app</span></span>
        <button class="auth-btn ghost" id="signOutBtn" type="button">Sign out</button>
      </div>`;
      box.querySelector('#signOutBtn').addEventListener('click', () => supa && supa.auth.signOut());
      return;
    }
    box.innerHTML = `<div class="auth-form">
      <button class="auth-google" id="googleBtn" type="button">${GOOGLE_ICON}<span>Continue with Google</span></button>
      <div class="auth-or"><span>or with email</span></div>
      <input class="auth-input" id="authEmail" type="email" autocomplete="email" placeholder="Email"/>
      <div class="auth-pass">
        <input class="auth-input" id="authPass" type="password" autocomplete="current-password" placeholder="Password"/>
        <button class="pass-toggle" id="togglePass" type="button" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>
      </div>
      <p class="auth-error" id="authError"></p>
      <div class="auth-actions">
        <button class="auth-btn" id="signInBtn" type="button">Sign in</button>
        <button class="auth-btn ghost" id="signUpBtn" type="button">Create account</button>
      </div>
    </div>`;
    const email = box.querySelector('#authEmail');
    const pass  = box.querySelector('#authPass');
    const err   = box.querySelector('#authError');
    box.querySelector('#googleBtn').addEventListener('click', () => {
      if (supa) supa.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
    });
    const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.3 13.3 0 0 1-1.67 2.34M6.1 6.1A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 3.9-.88"/><path d="M1 1l22 22"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
    const togBtn = box.querySelector('#togglePass');
    togBtn.addEventListener('click', () => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      togBtn.innerHTML = show ? EYE_OFF : EYE;
      togBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    box.querySelector('#signInBtn').addEventListener('click', async () => {
      if (!supa) return;
      err.textContent = ''; err.className = 'auth-error';
      const { error } = await supa.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) err.textContent = error.message;
    });
    box.querySelector('#signUpBtn').addEventListener('click', async () => {
      if (!supa) return;
      err.textContent = ''; err.className = 'auth-error';
      const { data, error } = await supa.auth.signUp({
        email: email.value.trim(), password: pass.value,
        options: { emailRedirectTo: window.location.href },
      });
      if (error) { err.textContent = error.message; return; }
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        err.textContent = 'This email is already registered. Try signing in.'; return;
      }
      err.className = 'auth-error ok'; err.textContent = 'Check your email to confirm your account!';
    });
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  renderAccount();

  // ── "Grab me a bubble tea" (Pro upgrade) — only when signed in & not Pro ──
  const proBox = document.getElementById('proBox');
  function renderPro() {
    if (!proBox) return;
    if (!user || plan === 'pro') { proBox.hidden = true; proBox.innerHTML = ''; return; }
    proBox.hidden = false;
    proBox.innerHTML = `
      <div class="pro-banner">
        <div class="pro-title">Grab me a bubble tea</div>
        <div class="pro-sub">Unlocks HSK 1–6</div>
      </div>
      <p class="pro-lead">Help keep Shuazi alive (and me awake 😅) — grab us a sweet bubble tea and unlock:</p>
      <ul class="pro-perks">
        <li>HSK 1–6 — all 1,500+ characters, forever</li>
        <li>Cross-device sync — pick up where you left off</li>
        <li>Built-in translator — with word segmentation</li>
      </ul>
      <div class="pro-qty">
        <img src="/images/bubbletea-brown.png" alt=""/>
        <span class="pro-x">×</span>
        <button class="qty on" data-qty="1" type="button">1</button>
        <button class="qty" data-qty="2" type="button">2</button>
        <button class="qty" data-qty="3" type="button">3</button>
        <input class="qty-custom" id="qtyCustom" type="number" min="1" max="100" value="1"/>
      </div>
      <button class="pro-cta" id="proCta" type="button">Support · €${BUBBLE_PRICE}</button>`;

    let qty = 1;
    const cta = proBox.querySelector('#proCta');
    const btns = proBox.querySelectorAll('.qty');
    const custom = proBox.querySelector('#qtyCustom');
    const setQty = (q, fromCustom) => {
      qty = Math.max(1, Math.min(100, q || 1));
      cta.textContent = `Support · €${qty * BUBBLE_PRICE}`;
      btns.forEach(b => b.classList.toggle('on', !fromCustom && +b.dataset.qty === qty));
      if (!fromCustom) custom.value = qty;
      else if (+custom.value > 100) custom.value = 100;   // don't let the field exceed 100
    };
    btns.forEach(b => b.addEventListener('click', () => setQty(+b.dataset.qty)));
    custom.addEventListener('input', () => setQty(+custom.value, true));
    cta.addEventListener('click', checkout.bind(null, () => qty));
  }

  async function checkout(getQty) {
    if (!supa || !user) return;
    const cta = proBox.querySelector('#proCta');
    if (cta) { cta.disabled = true; cta.textContent = 'Redirecting…'; }
    try {
      const { data: { session } } = await supa.auth.getSession();
      const resp = await fetch(`${SUPA_URL}/functions/v1/bright-worker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          price_id: STRIPE_PRICE,
          quantity: getQty(),
          user_id: user.id,
          success_url: window.location.origin + window.location.pathname + '?upgraded=1',
          cancel_url: window.location.origin + window.location.pathname,
        }),
      });
      const json = await resp.json();
      if (json.url) window.location.assign(json.url);
      else { alert('Error: ' + (json.error || 'no url returned')); renderPro(); }
    } catch (e) { alert('Error: ' + e.message); renderPro(); }
  }

  async function loadRemote() {
    if (!supa || !user) return;
    const [{ data: cData }, { data: wData }] = await Promise.all([
      supa.from('progress').select('char_id,state').eq('user_id', user.id),
      supa.from('word_progress').select('word_id,state').eq('user_id', user.id),
    ]);
    // Remote is authoritative for ids we know about.
    Object.values(idName.char).forEach(n => { known.delete(n); review.delete(n); });
    Object.values(idName.word).forEach(n => { known.delete(n); review.delete(n); });
    (cData || []).forEach(r => { const n = idName.char[r.char_id]; if (!n) return; if (r.state === 'known') known.add(n); if (r.state === 'review') review.add(n); });
    (wData || []).forEach(r => { const n = idName.word[r.word_id]; if (!n) return; if (r.state === 'known') known.add(n); if (r.state === 'review') review.add(n); });
    persistLocal();
    render();
  }

  async function refreshPlan() {
    plan = 'free';
    if (!user) return;
    try {
      const { data } = await supa.from('profiles').select('plan').eq('id', user.id).maybeSingle();
      plan = data?.plan || 'free';
    } catch (e) {}
  }

  // ── Theme synced with the account (shuazi user_settings.theme), same as the app ──
  async function loadTheme() {
    if (!supa || !user) return;
    try {
      const { data } = await supa.from('user_settings').select('theme').eq('user_id', user.id).maybeSingle();
      if (data && (data.theme === 'dark' || data.theme === 'light')) {
        document.documentElement.dataset.theme = data.theme;
        try { localStorage.setItem('shuazi-theme', data.theme); } catch (e) {}
      }
    } catch (e) {}
  }
  async function saveTheme() {
    if (!supa || !user) return;
    const t = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    try {
      await supa.from('user_settings').upsert(
        { user_id: user.id, theme: t, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' });
    } catch (e) {}
  }
  // dict.js toggles the theme first (head, defer); we persist it after.
  document.getElementById('themeToggle')?.addEventListener('click', () => { saveTheme(); });

  async function start() {
    if (!window.supabase) return;
    supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
    const { data: { session } } = await supa.auth.getSession();
    user = session?.user ?? null;
    renderAccount();
    await refreshPlan(); renderPro();
    await loadTheme();
    await loadRemote();
    supa.auth.onAuthStateChange(async (_e, s) => {
      user = s?.user ?? null;
      renderAccount();
      await refreshPlan(); renderPro();
      await loadTheme();
      await loadRemote();
    });
  }
  if (window.supabase) start(); else window._supaReady = start;
})();
