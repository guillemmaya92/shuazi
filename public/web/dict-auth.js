/* Sign-in + progress marking for the dictionary browse pages.
   Shares state with the main app: the same localStorage key ('shuazi-v1') and
   the same Supabase tables (progress / word_progress), so anything you mark here
   shows up in the app and vice-versa. */
(() => {
  const SUPA_URL = 'https://coysmojauucqgdhhxyrz.supabase.co';
  const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNveXNtb2phdXVjcWdkaGh4eXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODAxOTMsImV4cCI6MjA5Njk1NjE5M30.JO6U0TyW5gcnmJMJAvvzSh_ZiMdCKCEtRSz_N8h8adM';
  const STORE_KEY = 'shuazi-v1';

  const tiles = [...document.querySelectorAll('.tile')];
  const gateWrap = document.querySelector('.gate-wrap[data-gate]');   // detail-page HSK lock
  if (!tiles.length && !gateWrap) return;

  // ── Local progress (shared with the app) ──
  const known = new Set(), review = new Set();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) {}
  (saved.known   || []).forEach(x => known.add(x));
  (saved.unknown || []).forEach(x => review.add(x));

  function persistLocal() {
    const out = { ...saved, known: [...known], unknown: [...review] };
    saved = out;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(out)); } catch (e) {}
  }

  // id → name maps (per type) for applying remote progress to the DOM
  const byId = { char: {}, word: {} };
  tiles.forEach(t => { byId[t.dataset.type][t.dataset.id] = t.dataset.name; });

  function updateBars() {
    document.querySelectorAll('.group').forEach(g => {
      const gt = g.querySelectorAll('.tile');
      const total = gt.length;
      let k = 0;
      gt.forEach(t => { if (known.has(t.dataset.name)) k++; });
      const fill = g.querySelector('.g-bar-fill');
      if (fill) fill.style.width = total ? (k / total * 100) + '%' : '0%';
      const cnt = g.querySelector('.g-count');
      if (cnt) cnt.textContent = `${k.toLocaleString('en-US')}/${total.toLocaleString('en-US')}`;
    });
  }

  function paint() {
    tiles.forEach(t => {
      const n = t.dataset.name;
      t.classList.toggle('known', known.has(n));
      t.classList.toggle('review', review.has(n));
    });
    updateBars();
  }
  paint();

  // ── Supabase session + HSK gating (free plan = only HSK 1–2, like the app) ──
  let supa = null, user = null, plan = 'free';
  const FREE = new Set([1, 2]);
  const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  const locked = lvl => plan !== 'pro' && !FREE.has(+lvl);

  function applyLocks() {
    // Level filter pills
    document.querySelectorAll('[data-role="levels"] [data-level]').forEach(p => {
      const lk = locked(p.dataset.level);
      p.classList.toggle('locked', lk);
      p.disabled = lk;
    });
    // Groups — locked levels show a "Sign up to unlock" note in the header where
    // the progress bar would be; the level stays collapsed.
    document.querySelectorAll('.group[data-level]').forEach(g => {
      const lk = locked(g.dataset.level);
      g.classList.toggle('locked', lk);
      const head = g.querySelector('.group-head');
      let note = head.querySelector('.g-lock');
      if (lk) {
        if (!note) {
          note = document.createElement('span');
          note.className = 'g-lock';
          head.insertBefore(note, head.querySelector('.g-chev'));
        }
        note.innerHTML = `${LOCK_SVG}<span>${user ? 'Upgrade to unlock' : 'Sign up to unlock'}</span>`;
      } else if (note) {
        note.remove();
      }
    });
  }
  applyLocks();

  // Detail page (character) HSK gate: the page renders its content for SEO but
  // stays locked for free users (HSK 3–6), and unlocks for Pro.
  function applyGate() {
    if (!gateWrap) return;
    const lk = locked(gateWrap.dataset.gate);
    gateWrap.classList.toggle('locked', lk);
    const label = gateWrap.querySelector('.gate-label');
    if (label) label.textContent = user ? 'Upgrade to unlock' : 'Sign up to unlock';
  }
  applyGate();

  // Tapping the lock note goes to the Profile (and never toggles the group).
  document.addEventListener('click', e => {
    if (e.target.closest('.g-lock')) {
      e.preventDefault(); e.stopPropagation();
      window.location.href = '/profile/';
    }
  }, true);

  // ── Supabase (loaded lazily) ──
  const tableFor = type => type === 'word' ? 'word_progress' : 'progress';
  const idColFor = type => type === 'word' ? 'word_id' : 'char_id';

  async function upsertRemote(type, id, state) {
    if (!supa || !user) return;
    const t = tableFor(type), col = idColFor(type);
    if (state) {
      await supa.from(t).upsert(
        { user_id: user.id, [col]: +id, state, updated_at: new Date().toISOString() },
        { onConflict: `user_id,${col}` });
    } else {
      await supa.from(t).delete().eq('user_id', user.id).eq(col, +id);
    }
  }

  async function loadRemote() {
    if (!supa || !user) return;
    const types = [...new Set(tiles.map(t => t.dataset.type))];
    for (const type of types) {
      const col = idColFor(type);
      const { data } = await supa.from(tableFor(type)).select(`${col},state`).eq('user_id', user.id);
      if (!data) continue;
      // Remote is authoritative for the ids shown on this page.
      Object.values(byId[type]).forEach(n => { known.delete(n); review.delete(n); });
      data.forEach(row => {
        const n = byId[type][row[col]];
        if (!n) return;
        if (row.state === 'known')  known.add(n);
        if (row.state === 'review') review.add(n);
      });
    }
    persistLocal();
    paint();
  }

  // ── Long-press a tile to cycle none → known → review → none ──
  // (No always-visible control: unmarked tiles stay clean; a long-press marks,
  // a normal tap follows the link to the detail page — just like the app.)
  function cycle(tile) {
    const name = tile.dataset.name, type = tile.dataset.type, id = tile.dataset.id;
    let state;
    if (known.has(name))       { known.delete(name); review.add(name); state = 'review'; }
    else if (review.has(name)) { review.delete(name);                  state = null; }
    else                       { known.add(name);                      state = 'known'; }
    paint();
    persistLocal();
    upsertRemote(type, id, state);
  }

  let timer = null, longFired = false, pressTile = null, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  document.addEventListener('pointerdown', e => {
    const tile = e.target.closest('.tile');
    if (!tile || !tile.dataset.id) return;
    pressTile = tile; longFired = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => {
      longFired = true;
      cycle(tile);
      if (navigator.vibrate) navigator.vibrate(18);
    }, 450);
  });
  document.addEventListener('pointermove', e => {
    if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) clear();
  });
  document.addEventListener('pointerup', clear);
  document.addEventListener('pointercancel', clear);
  // Swallow the click that follows a long-press so it doesn't open the link.
  document.addEventListener('click', e => {
    if (longFired && e.target.closest('.tile') === pressTile) {
      e.preventDefault(); e.stopPropagation();
    }
    longFired = false;
  }, true);

  // ── Optional auth bar (login lives on the Profile page; these pages may not
  //    have it, but we still load the session to sync remote progress) ──
  const bar = document.getElementById('authBar');
  const statusEl = document.getElementById('authStatus');
  const btn = document.getElementById('authBtn');
  if (bar) bar.hidden = false;

  function renderAuth() {
    if (!statusEl || !btn) return;
    if (user) {
      statusEl.textContent = `Signed in as ${user.email || 'your account'} · progress syncs with the app`;
      btn.textContent = 'Sign out';
      btn.className = 'auth-btn ghost';
    } else {
      statusEl.textContent = 'Sign in to save what you know and sync it with the app.';
      btn.textContent = 'Sign in';
      btn.className = 'auth-btn';
    }
  }
  btn?.addEventListener('click', async () => {
    if (user) { if (supa) await supa.auth.signOut(); }
    else { window.location.href = '/profile/'; }   // full login lives on Profile
  });
  renderAuth();

  async function refreshPlan() {
    plan = 'free';
    if (!supa || !user) return;
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
    renderAuth();
    await refreshPlan(); applyLocks(); applyGate();
    await loadTheme();
    await loadRemote();
    supa.auth.onAuthStateChange(async (_e, s) => {
      user = s?.user ?? null;
      renderAuth();
      await refreshPlan(); applyLocks(); applyGate();
      await loadTheme();
      await loadRemote();
    });
  }
  if (window.supabase) start(); else window._supaReady = start;
})();
