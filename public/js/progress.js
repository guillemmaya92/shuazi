import { supa, STORE_KEY } from './config.js';
import { state } from './state.js';

export async function syncProgressToSupabase() {
  if (!state.supaUser) return;
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
}

export async function loadProgressFromSupabase() {
  if (!state.supaUser) return;
  const { data } = await supa.from('progress').select('char_id, state').eq('user_id', state.supaUser.id);
  if (!data) return;
  state.known.clear(); state.unknown.clear();
  data.forEach(row => {
    const c = state.charById[row.char_id];
    if (!c) return;
    if (row.state === 'known')  state.known.add(c.char);
    if (row.state === 'review') state.unknown.add(c.char);
  });
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
