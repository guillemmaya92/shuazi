import { supa, STORE_KEY, SETTINGS_KEY } from './config.js';
import { state } from './state.js';
import { applyLanguage, applyStaticTranslations } from './i18n.js';

// SRS scheduling columns for an item (empty when it was never graded).
function srsCols(name) {
  const s = state.schedule[name];
  return {
    due_at:        s?.due  ? new Date(s.due).toISOString()  : null,
    interval_days: s?.interval ?? null,
    ease:          s?.ease ?? null,
    reps:          s?.reps ?? null,
    last_reviewed: s?.last ? new Date(s.last).toISOString() : null,
  };
}

export async function syncProgressToSupabase() {
  if (!state.supaUser) return;

  // Chars
  const knownRows = [], reviewRows = [], leftIds = [];
  state.CHARACTERS.forEach(c => {
    if (state.known.has(c.char))
      knownRows.push({ user_id: state.supaUser.id, char_id: c.id, state: 'known',  updated_at: new Date().toISOString(), ...srsCols(c.char) });
    else if (state.unknown.has(c.char))
      reviewRows.push({ user_id: state.supaUser.id, char_id: c.id, state: 'review', updated_at: new Date().toISOString(), ...srsCols(c.char) });
    else
      leftIds.push(c.id);
  });
  const upsertRows = [...knownRows, ...reviewRows];
  if (upsertRows.length > 0)
    await supa.from('progress').upsert(upsertRows, { onConflict: 'user_id,char_id' });
  if (leftIds.length > 0)
    await supa.from('progress').delete().eq('user_id', state.supaUser.id).in('char_id', leftIds);

  // Words
  const wKnownRows = [], wReviewRows = [], wLeftIds = [];
  state.WORDS.forEach(w => {
    if (state.known.has(w.word))
      wKnownRows.push({ user_id: state.supaUser.id, word_id: w.id, state: 'known',  updated_at: new Date().toISOString(), ...srsCols(w.word) });
    else if (state.unknown.has(w.word))
      wReviewRows.push({ user_id: state.supaUser.id, word_id: w.id, state: 'review', updated_at: new Date().toISOString(), ...srsCols(w.word) });
    else
      wLeftIds.push(w.id);
  });
  const wUpsertRows = [...wKnownRows, ...wReviewRows];
  if (wUpsertRows.length > 0)
    await supa.from('word_progress').upsert(wUpsertRows, { onConflict: 'user_id,word_id' });
  if (wLeftIds.length > 0)
    await supa.from('word_progress').delete().eq('user_id', state.supaUser.id).in('word_id', wLeftIds);
}

export async function loadProgressFromSupabase() {
  if (!state.supaUser) return;

  const cols = 'state, due_at, interval_days, ease, reps, last_reviewed';
  const [{ data: charData }, { data: wordData }] = await Promise.all([
    supa.from('progress').select(`char_id, ${cols}`).eq('user_id', state.supaUser.id),
    supa.from('word_progress').select(`word_id, ${cols}`).eq('user_id', state.supaUser.id),
  ]);

  state.known.clear(); state.unknown.clear(); state.schedule = {};

  // Rehydrate the SRS record for an item from its remote row (if it has one).
  const applySched = (name, row) => {
    if (!row.due_at) return;
    state.schedule[name] = {
      interval: row.interval_days ?? 0,
      ease:     row.ease ?? 2.3,
      reps:     row.reps ?? 0,
      due:      Date.parse(row.due_at),
      last:     row.last_reviewed ? Date.parse(row.last_reviewed) : 0,
    };
  };

  if (charData) {
    charData.forEach(row => {
      const c = state.charById[row.char_id];
      if (!c) return;
      if (row.state === 'known')  state.known.add(c.char);
      if (row.state === 'review') state.unknown.add(c.char);
      applySched(c.char, row);
    });
  }

  if (wordData) {
    const wordById = Object.fromEntries(state.WORDS.map(w => [w.id, w]));
    wordData.forEach(row => {
      const w = wordById[row.word_id];
      if (!w) return;
      if (row.state === 'known')  state.known.add(w.word);
      if (row.state === 'review') state.unknown.add(w.word);
      applySched(w.word, row);
    });
  }
}

export function scheduleSyncToSupabase() {
  if (!state.supaUser) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(syncProgressToSupabase, 1500);
}

export function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      known:     [...state.known],
      unknown:   [...state.unknown],
      schedule:  state.schedule,
      deckChars: state.deck.map(c => c.char)
    }));
  } catch (e) {}
  scheduleSyncToSupabase();
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// ── User settings (game mode + active filters) ──────────────────────────────
// Persisted locally for instant restore and, when signed in, mirrored to the
// `user_settings` table so the config follows the account across devices.

function settingsPayload() {
  return {
    game:     state.groupsContent,
    hsk:      [...state.activeHskLevels],
    statuses: [...state.activeStatuses],
    theme:    state.theme,
    showPinyin: state.showPinyin,
    lang:     state.lang,
  };
}

export async function syncSettingsToSupabase() {
  if (!state.supaUser) return;
  await supa.from('user_settings').upsert({
    user_id:    state.supaUser.id,
    game:       state.groupsContent,
    hsk_levels: [...state.activeHskLevels],
    statuses:   [...state.activeStatuses],
    theme:      state.theme,
    lang:       state.lang,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
}

// Call whenever the user changes the game mode or a filter. Writes localStorage
// immediately and debounces the Supabase write.
export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsPayload())); } catch (e) {}
  if (!state.supaUser) return;
  clearTimeout(state.settingsTimer);
  state.settingsTimer = setTimeout(syncSettingsToSupabase, 1500);
}

export async function loadSettingsFromSupabase() {
  if (!state.supaUser) return;
  const { data } = await supa
    .from('user_settings')
    .select('game, hsk_levels, statuses, theme, lang')
    .eq('user_id', state.supaUser.id)
    .maybeSingle();
  if (!data) {
    // First sign-in on this account (i.e. just registered): start with every
    // HSK level active, then seed the row from the device's settings.
    state.activeHskLevels = new Set([1, 2, 3, 4, 5, 6, 7]);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsPayload())); } catch (e) {}
    syncSettingsToSupabase();
    return;
  }
  if (data.game === 'words' || data.game === 'characters') state.groupsContent = data.game;
  if (Array.isArray(data.hsk_levels) && data.hsk_levels.length) state.activeHskLevels = new Set(data.hsk_levels);
  if (Array.isArray(data.statuses) && data.statuses.length)     state.activeStatuses  = new Set(data.statuses);
  if (data.theme === 'dark' || data.theme === 'light')          state.theme = data.theme;
  // Adopt the account's language and re-localize any already-loaded content, so
  // the deck/grid the caller renders next is in the right language.
  if ((data.lang === 'en' || data.lang === 'es') && data.lang !== state.lang) {
    state.lang = data.lang;
    applyLanguage();
    applyStaticTranslations();
  }
  // Mirror back to localStorage so the next synchronous boot already has them
  // (settings + the standalone theme key the inline boot script reads).
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsPayload())); } catch (e) {}
  try { localStorage.setItem('shuazi-theme', state.theme); } catch (e) {}
}
