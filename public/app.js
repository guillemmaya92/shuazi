import { supa } from './js/config.js';
import { state } from './js/state.js';
import { loadUserPlan, syncUserProfile } from './js/auth.js';
import { loadProgressFromSupabase, loadSettingsFromSupabase, loadState } from './js/progress.js';
import { buildDeck, buildWordDeck, render, init, stats } from './js/cards.js';
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

// Granular loaders so the boot sequence can put exactly the right table on the
// critical path: CHARACTERS for "characters" mode, WORDS for "words" mode.
async function loadChars() {
  const chars = await fetchAll('chars', 'id, char, pinyin, meaning, radical, hsk, stroke, productive, coverage, frequency');
  state.CHARACTERS = chars;
  state.charById   = Object.fromEntries(chars.map(c => [c.id, c]));
}

async function loadWords() {
  state.WORDS = await fetchAll('words', 'id, word, pinyin, meaning, hsk, productive, coverage, stroke, pos');
}

// Small lookup table: part-of-speech code → human-readable description.
// Shown on the word card's info page, so it's never on the critical path.
async function loadPosTags() {
  try {
    const tags = await fetchAll('pos_tags', 'pos, description', 'pos');
    state.POS_TAGS = Object.fromEntries(tags.map(t => [t.pos, t.description]));
  } catch (e) {
    console.error('pos_tags failed to load (cards unaffected):', e);
  }
}

async function loadRadicalsAndSlang() {
  const [radicals, slang] = await Promise.all([
    fetchAll('radicals', 'id, radical, traditional, pinyin, meaning, stroke, productive, coverage'),
    fetchAll('slang', 'id, slang, pinyin, literal, meaning, origin, image'),
  ]);
  state.RADICALS = radicals;
  // renderSlang uses phrase.id as the hanzi — map the `slang` column onto it.
  state.PHRASES  = slang.map(s => ({
    id:      s.slang,
    pinyin:  s.pinyin,
    literal: s.literal,
    meaning: s.meaning,
    origin:  s.origin,
    image:   s.image,
  }));
}

// Components are optional — a failure here must never block chars/cards.
async function loadComponents() {
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

// Critical path for first paint: only the table the active mode's first card
// needs. Everything else streams in behind it via loadRest().
async function loadCritical(mode) {
  await window._supabaseReady;
  await (mode === 'words' ? loadWords() : loadChars());
}

async function loadRest(mode) {
  await Promise.all([
    loadRadicalsAndSlang(),
    loadComponents(),
    loadPosTags(),
    mode === 'words' ? loadChars() : loadWords(),
  ]);
}

// Build the deck for whichever mode is active — words or characters.
const rebuildDeck = () =>
  state.groupsContent === 'words' ? buildWordDeck() : buildDeck(state.CHARACTERS);

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
    state.deck = rebuildDeck();
    render();
    renderGroups();
    renderProfile();
  }, 2000);
}

const bootMode = state.groupsContent;

loadCritical(bootMode).then(() => {
  // Paint the first card the instant its table is available — nothing else is
  // on the critical path.
  if (bootMode === 'words') {
    // No init() here: that path restores a *character* deck. Restore the shared
    // known/review marks from localStorage, then build a fresh word deck.
    const saved = loadState();
    if (saved) {
      state.known   = new Set(saved.known   || []);
      state.unknown = new Set(saved.unknown || []);
    }
    state.deck = buildWordDeck();
    render();
  } else {
    init(state.CHARACTERS);
  }
  initPwaInstall();

  // The remaining tables stream in behind the first paint.
  const restReady = loadRest(bootMode).then(() => {
    renderGroups();
    // Refresh the card so its info page fills in (radical pinyin in chars mode,
    // per-character chips in words mode) — but only while the user is in a
    // neutral state, so we never interrupt a swipe or a revealed answer.
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
      await loadSettingsFromSupabase();
      setTheme(state.theme);   // apply the account's saved theme
      await restReady;
      state.deck = rebuildDeck();
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
        await loadSettingsFromSupabase();
        setTheme(state.theme);   // apply the account's saved theme
        await restReady;
        state.deck = rebuildDeck();
        render();
        stats();
        renderGroups();
        renderProfile();
      }
      if (event === 'SIGNED_OUT') {
        state.userPlan = 'free';
        state.known.clear(); state.unknown.clear();
        state.deck = rebuildDeck();
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
