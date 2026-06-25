import { supa } from './js/config.js';
import { state } from './js/state.js';
import { loadUserPlan, syncUserProfile } from './js/auth.js';
import { loadProgressFromSupabase } from './js/progress.js';
import { buildDeck, render, init, stats } from './js/cards.js';
import { renderGroups, renderProfile, setTheme } from './js/ui.js';
import { initPwaInstall } from './js/pwa-install.js';

// Paginated fetch — Supabase caps each request at 1000 rows. Grab the row count
// first, then fire every page in parallel (≈2 round-trips instead of N
// sequential ones). Falls back to sequential paging if the count is unavailable.
async function fetchAll(table, columns, orderBy = 'id') {
  const pageSize = 1000;

  const { count, error: cErr } = await supa
    .from(table)
    .select('*', { count: 'exact', head: true });

  if (!cErr && count != null) {
    const pages = Math.max(1, Math.ceil(count / pageSize));
    const results = await Promise.all(
      Array.from({ length: pages }, (_, p) =>
        supa.from(table).select(columns).order(orderBy).range(p * pageSize, (p + 1) * pageSize - 1)
      )
    );
    const all = [];
    for (const r of results) { if (r.error) throw r.error; all.push(...r.data); }
    return all;
  }

  // Fallback: sequential paging when no count header is returned.
  let from = 0, all = [];
  for (;;) {
    const { data, error } = await supa
      .from(table)
      .select(columns)
      .order(orderBy)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Critical path for first paint: just the characters. The first card only needs
// CHARACTERS, so nothing else is allowed to block it.
async function loadChars() {
  await window._supabaseReady;
  const chars = await fetchAll('chars', 'id, char, pinyin, meaning, radical, hsk, stroke, productive, coverage, frequency');
  state.CHARACTERS = chars;
  state.charById   = Object.fromEntries(chars.map(c => [c.id, c]));
}

// Everything else (radicals, slang, words, components) streams in behind the
// first card and only matters for the Groups grid / card info pages.
async function loadRest() {
  const [radicals, slang, words] = await Promise.all([
    fetchAll('radicals', 'id, radical, traditional, pinyin, meaning, stroke, productive, coverage'),
    fetchAll('slang', 'id, slang, pinyin, literal, meaning, origin, image'),
    fetchAll('words', 'id, word, pinyin, meaning, hsk, productive, coverage, stroke')
  ]);
  state.WORDS   = words;
  // renderSlang uses phrase.id as the hanzi — map the `slang` column onto it.
  state.PHRASES = slang.map(s => ({
    id:      s.slang,
    pinyin:  s.pinyin,
    literal: s.literal,
    meaning: s.meaning,
    origin:  s.origin,
    image:   s.image,
  }));
  state.RADICALS = radicals;

  // Components are optional — a failure here must never block chars/cards.
  try {
    const [components, compChar] = await Promise.all([
      fetchAll('components', 'id, component, pinyin, meaning, stroke, productive, coverage'),
      fetchAll('component_char', 'id_component, id_char', 'id_component')
    ]);
    // Some components have null pinyin/meaning — coalesce so sort/search/render never crash.
    state.COMPONENTS = components.map(c => ({
      ...c,
      component: c.component ?? '',
      pinyin:    c.pinyin    ?? '',
      meaning:   c.meaning   ?? '',
    }));
    // component_char is many-to-many — build component id → set of char ids for filtering.
    const byComp = {};
    compChar.forEach(({ id_component, id_char }) => {
      (byComp[id_component] ||= new Set()).add(id_char);
    });
    state.charsByComponent = byComp;
  } catch (e) {
    console.error('Components failed to load (chars/cards unaffected):', e);
  }
}

// Restore theme before first paint
try {
  const t = localStorage.getItem('shuazi-theme');
  if (t) setTheme(t);
} catch (e) {}

// Handle return from Stripe payment
if (new URLSearchParams(window.location.search).get('upgraded') === '1') {
  window.history.replaceState({}, '', window.location.pathname);
  setTimeout(async () => {
    await window._supabaseReady;
    await loadUserPlan();
    state.deck = buildDeck(state.CHARACTERS);
    render();
    renderGroups();
    renderProfile();
  }, 2000);
}

loadChars().then(() => {
  // Paint the first card the instant characters are available — nothing else
  // is on the critical path.
  init(state.CHARACTERS);
  initPwaInstall();

  // Radicals / slang / words / components stream in behind the first paint.
  const restReady = loadRest().then(() => {
    renderGroups();
    // Refresh the card so the radical pinyin on its info page populates — but
    // only while the user is in a neutral state, so we never interrupt a swipe
    // or a revealed answer.
    const top = document.querySelector('#deck .card.top');
    if (top && top.dataset.page === '0' && top.dataset.answer !== '1') render();
  });

  // Auth check in background: updates deck/progress once session is known.
  window._supabaseReady.then(async () => {
    const { data: { session } } = await supa.auth.getSession();
    if (session) {
      state.supaUser = session.user;
      syncUserProfile();
      await loadUserPlan();
      await loadProgressFromSupabase();
      await restReady;
      state.deck = buildDeck(state.CHARACTERS);
      render();
      renderGroups();
      renderProfile();
    }
  });

  window._supabaseReady.then(() => {
    supa.auth.onAuthStateChange(async (event, session) => {
      state.supaUser = session?.user ?? null;
      if (event === 'SIGNED_IN') {
        syncUserProfile();
        await loadUserPlan();
        await loadProgressFromSupabase();
        await restReady;
        state.deck = buildDeck(state.CHARACTERS);
        render();
        stats();
        renderGroups();
        renderProfile();
      }
      if (event === 'SIGNED_OUT') {
        state.userPlan = 'free';
        state.known.clear(); state.unknown.clear();
        state.deck = buildDeck(state.CHARACTERS);
        render();
        stats();
        renderGroups();
        renderProfile();
      }
    });
  });
}).catch(err => {
  console.error('Failed to load data:', err);
  document.getElementById('deck').innerHTML = '<div class="done"><div class="done-emoji">⚠️</div><h2>Error loading data</h2><p>Check the browser console for details.</p></div>';
});


if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered', reg))
      .catch(err => console.log('SW fail', err));
  });
}

window.addEventListener('appinstalled', () => {
  gtag('event', 'pwa_install');
});
