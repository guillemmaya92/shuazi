import { supa } from './js/config.js';
import { state } from './js/state.js';
import { loadUserPlan } from './js/auth.js';
import { loadProgressFromSupabase } from './js/progress.js';
import { buildDeck, render, init, stats } from './js/cards.js';
import { renderGroups, renderProfile, setTheme } from './js/ui.js';

// Paginated fetch — Supabase caps each request at 1000 rows, so page through.
async function fetchAll(table, columns, orderBy = 'id') {
  const pageSize = 1000;
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

async function loadData() {
  await window._supabaseReady;
  const [chars, radicals, slang] = await Promise.all([
    fetchAll('chars', 'id, char, pinyin, meaning, radical, hsk, stroke, productive, coverage, frequency'),
    fetchAll('radicals', 'id, radical, traditional, pinyin, meaning, stroke, productive, coverage'),
    fetchAll('slang', 'id, slang, pinyin, literal, meaning, origin, image')
  ]);
  state.CHARACTERS = chars;
  // renderSlang uses phrase.id as the hanzi — map the `slang` column onto it.
  state.PHRASES    = slang.map(s => ({
    id:      s.slang,
    pinyin:  s.pinyin,
    literal: s.literal,
    meaning: s.meaning,
    origin:  s.origin,
    image:   s.image,
  }));
  state.RADICALS   = radicals;
  state.charById   = Object.fromEntries(chars.map(c => [c.id, c]));

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

loadData().then(async () => {
  // Render immediately after data loads — don't block on auth for LCP
  init(state.CHARACTERS);
  renderGroups();

  // Auth check in background: updates deck/progress once session is known
  window._supabaseReady.then(async () => {
    const { data: { session } } = await supa.auth.getSession();
    if (session) {
      state.supaUser = session.user;
      await loadUserPlan();
      await loadProgressFromSupabase();
      state.deck = buildDeck(state.CHARACTERS);
      render();
      renderGroups();
      renderProfile();
    }
  });

  await window._supabaseReady;
  supa.auth.onAuthStateChange(async (event, session) => {
    state.supaUser = session?.user ?? null;
    if (event === 'SIGNED_IN') {
      await loadUserPlan();
      await loadProgressFromSupabase();
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
