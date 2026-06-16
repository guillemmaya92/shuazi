import { supa } from './js/config.js';
import { state } from './js/state.js';
import { loadUserPlan } from './js/auth.js';
import { loadProgressFromSupabase } from './js/progress.js';
import { buildDeck, render, init, stats } from './js/cards.js';
import { renderGroups, renderProfile, setTheme } from './js/ui.js';

async function loadData() {
  const [chars, words, phrases, radicals] = await Promise.all([
    fetch('./data/characters.json').then(r => r.json()),
    fetch('./data/words.json').then(r => r.json()),
    fetch('./data/slang.json').then(r => r.json()).catch(() => []),
    fetch('./data/radicals.json').then(r => r.json()).catch(() => [])
  ]);
  state.CHARACTERS = chars;
  state.WORDS      = words;
  state.PHRASES    = phrases;
  state.RADICALS   = radicals;
  state.charById   = Object.fromEntries(chars.map(c => [c.id, c]));
  words.forEach(w => {
    const seen = new Set();
    w.chars.forEach(cid => {
      if (seen.has(cid)) return;
      seen.add(cid);
      const ch = state.charById[cid]?.char;
      if (!ch) return;
      if (!state.wordsByChar[ch]) state.wordsByChar[ch] = [];
      if (!state.wordsByChar[ch].find(x => x.id === w.id)) state.wordsByChar[ch].push(w);
    });
  });
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
    await loadUserPlan();
    state.deck = buildDeck(state.CHARACTERS);
    render();
    renderGroups();
    renderProfile();
  }, 2000);
}

loadData().then(async () => {
  const { data: { session } } = await supa.auth.getSession();
  if (session) {
    state.supaUser = session.user;
    await loadUserPlan();
    await loadProgressFromSupabase();
    state.deck = buildDeck(state.CHARACTERS);
    render();
  } else {
    init(state.CHARACTERS);
  }
  renderGroups();

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
