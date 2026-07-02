import { supa } from './js/config.js';
import { state } from './js/state.js';
import { localizeRow, L, LANG_FIELDS, applyStaticTranslations } from './js/i18n.js';
import { loadUserPlan, syncUserProfile } from './js/auth.js';
import { loadProgressFromSupabase, loadSettingsFromSupabase, loadState } from './js/progress.js';
import { buildDeck, buildWordDeck, render, init, stats } from './js/cards.js';
import { renderGroups, renderProfile, setTheme } from './js/ui.js';
import { initPwaInstall } from './js/pwa-install.js';
import { maybeDemoSwipe } from './js/coach.js';
import { showPasswordReset } from './js/password-reset.js';

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
  const chars = await fetchAll('chars', 'id, char, pinyin, meaning, meaning_es, radical, hsk, stroke, productive, frequency');
  chars.forEach(c => localizeRow(c, LANG_FIELDS.chars));
  state.CHARACTERS = chars;
  state.charById   = Object.fromEntries(chars.map(c => [c.id, c]));
}

async function loadWords() {
  const words = await fetchAll('words', 'id, word, pinyin, meaning, meaning_es, hsk, productive, frequency, stroke, pos');
  words.forEach(w => localizeRow(w, LANG_FIELDS.words));
  state.WORDS = words;
}

// Small lookup table: part-of-speech code → human-readable description.
// Shown on the word card's info page, so it's never on the critical path.
async function loadPosTags() {
  try {
    const tags = await fetchAll('pos_tags', 'pos, description, description_es', 'pos');
    state._posTags = tags;   // keep raw rows so the map can be rebuilt per language
    state.POS_TAGS = Object.fromEntries(tags.map(t => [t.pos, L(t, 'description')]));
  } catch (e) {
    console.error('pos_tags failed to load (cards unaffected):', e);
  }
}

async function loadRadicalsAndSlang() {
  const [radicals, slang] = await Promise.all([
    fetchAll('radicals', 'id, radical, traditional, pinyin, meaning, meaning_es, stroke, productive, frequency'),
    fetchAll('slang', 'id, slang, pinyin, literal, literal_es, meaning, meaning_es, origin, origin_es, image'),
  ]);
  radicals.forEach(r => localizeRow(r, LANG_FIELDS.radicals));
  state.RADICALS = radicals;
  // renderSlang uses phrase.id as the hanzi — map the `slang` column onto it.
  state.PHRASES  = slang.map(s => localizeRow({
    id:         s.slang,
    pinyin:     s.pinyin,
    literal:    s.literal,
    literal_es: s.literal_es,
    meaning:    s.meaning,
    meaning_es: s.meaning_es,
    origin:     s.origin,
    origin_es:  s.origin_es,
    image:      s.image,
  }, LANG_FIELDS.phrases));
}

// Components are optional — a failure here must never block chars/cards.
async function loadComponents() {
  try {
    const [components, compChar] = await Promise.all([
      fetchAll('components', 'id, component, pinyin, meaning, meaning_es, stroke, productive, frequency'),
      fetchAll('component_char', 'id_component, id_char', 'id_component')
    ]);
    // Some components have null pinyin/meaning — coalesce so sort/search/render never crash.
    state.COMPONENTS = components.map(c => localizeRow({
      ...c,
      component: c.component ?? '',
      pinyin:    c.pinyin    ?? '',
      meaning:   c.meaning   ?? '',
    }, LANG_FIELDS.components));
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

// Rebuild the deck but keep whatever card is currently on top still in front, so
// an async load (progress/settings after auth) never yanks the card the user is
// already looking at out from under them on open. Falls back to a fresh build's
// order if that card is no longer in the deck (e.g. filtered out by settings).
const rebuildDeckKeepingTop = () => {
  const prevTopChar = state.deck && state.deck[0] && state.deck[0].char;
  const next = rebuildDeck();
  const i = prevTopChar ? next.findIndex(c => c.char === prevTopChar) : -1;
  if (i > 0) next.unshift(next.splice(i, 1)[0]);
  return next;
};

// Restore theme before first paint
try {
  const t = localStorage.getItem('shuazi-theme');
  if (t) setTheme(t);
} catch (e) {}

// Translate the static chrome to the saved language before first paint.
applyStaticTranslations();

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
      state.known    = new Set(saved.known   || []);
      state.unknown  = new Set(saved.unknown || []);
      state.schedule = saved.schedule || {};
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
    // First run: the top card demos the swipe by itself. Deferred to here so the
    // re-render above (which rebuilds the card DOM) can't wipe the animation.
    if (state.deck && state.deck.length) maybeDemoSwipe();
  });

  // Auth check in background: updates deck/progress once session is known.
  window._supabaseReady.then(async () => {
    // Arriving from an email-confirmation link? The custom Supabase template
    // points at our own domain (in the PWA scope) as
    //   {{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=email
    // so an installed PWA can open it directly (see manifest launch_handler /
    // handle_links). Verify the token here, then strip the params so a refresh
    // is clean. On the browser this simply confirms the email as before.
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get('token_hash');
    const otpType = params.get('type');
    if (tokenHash && otpType) {
      let ok = true;
      try {
        await supa.auth.verifyOtp({ type: otpType, token_hash: tokenHash });
      } catch (e) {
        ok = false;
        console.error('Token verification failed:', e);
      }
      params.delete('token_hash'); params.delete('type');
      const qs = params.toString();
      history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      // Password-recovery link → collect a new password (custom email template
      // points here with type=recovery, mirroring the confirm-signup flow). The
      // token is single-use: a reused/expired link fails verify → show that.
      if (otpType === 'recovery') showPasswordReset({ expired: !ok });
    }

    const { data: { session } } = await supa.auth.getSession();
    if (session) {
      state.supaUser = session.user;
      syncUserProfile();
      await loadUserPlan();
      await loadProgressFromSupabase();
      await loadSettingsFromSupabase();
      setTheme(state.theme);   // apply the account's saved theme
      await restReady;
      state.deck = rebuildDeckKeepingTop();
      render();
      renderGroups();
      renderProfile();
    }
  });

  window._supabaseReady.then(() => {
    supa.auth.onAuthStateChange(async (event, session) => {
      state.supaUser = session?.user ?? null;
      if (event === 'PASSWORD_RECOVERY') showPasswordReset();
      if (event === 'SIGNED_IN') {
        syncUserProfile();
        await loadUserPlan();
        await loadProgressFromSupabase();
        await loadSettingsFromSupabase();
        setTheme(state.theme);   // apply the account's saved theme
        await restReady;
        state.deck = rebuildDeckKeepingTop();
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
