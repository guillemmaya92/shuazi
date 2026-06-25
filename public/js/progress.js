import { supa, STORE_KEY } from './config.js';
import { state } from './state.js';

export async function syncProgressToSupabase() {
  if (!state.supaUser) return;

  // Chars
  const knownRows = [], reviewRows = [], leftIds = [];
  state.CHARACTERS.forEach(c => {
    if (state.known.has(c.char))
      knownRows.push({ user_id: state.supaUser.id, char_id: c.id, state: 'known',  updated_at: new Date().toISOString() });
    else if (state.unknown.has(c.char))
      reviewRows.push({ user_id: state.supaUser.id, char_id: c.id, state: 'review', updated_at: new Date().toISOString() });
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
      wKnownRows.push({ user_id: state.supaUser.id, word_id: w.id, state: 'known',  updated_at: new Date().toISOString() });
    else if (state.unknown.has(w.word))
      wReviewRows.push({ user_id: state.supaUser.id, word_id: w.id, state: 'review', updated_at: new Date().toISOString() });
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

  const [{ data: charData }, { data: wordData }] = await Promise.all([
    supa.from('progress').select('char_id, state').eq('user_id', state.supaUser.id),
    supa.from('word_progress').select('word_id, state').eq('user_id', state.supaUser.id),
  ]);

  state.known.clear(); state.unknown.clear();

  if (charData) {
    charData.forEach(row => {
      const c = state.charById[row.char_id];
      if (!c) return;
      if (row.state === 'known')  state.known.add(c.char);
      if (row.state === 'review') state.unknown.add(c.char);
    });
  }

  if (wordData) {
    const wordById = Object.fromEntries(state.WORDS.map(w => [w.id, w]));
    wordData.forEach(row => {
      const w = wordById[row.word_id];
      if (!w) return;
      if (row.state === 'known')  state.known.add(w.word);
      if (row.state === 'review') state.unknown.add(w.word);
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
