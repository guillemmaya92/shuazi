// Restore the saved user settings (game mode + active filters) synchronously so
// the boot sequence can put the matching data on the critical path and build the
// first deck with the right filters. For signed-in users these are refreshed from
// Supabase on login (see loadSettingsFromSupabase).
let _initialMode     = 'characters';
let _initialHsk      = [1, 2, 3, 4, 5, 6];
let _initialStatuses = ['left', 'know', 'review'];
try {
  const s = JSON.parse(localStorage.getItem('shuazi-settings') || '{}');
  if (s.game === 'words' || s.game === 'characters') _initialMode = s.game;
  if (Array.isArray(s.hsk) && s.hsk.length)          _initialHsk = s.hsk;
  if (Array.isArray(s.statuses) && s.statuses.length) _initialStatuses = s.statuses;
} catch (e) {}

export const state = {
  CHARACTERS:    [],
  WORDS:         [],
  PHRASES:       [],
  RADICALS:      [],
  COMPONENTS:    [],
  POS_TAGS:      {},
  charsByComponent: {},
  charById:      {},
  wordsByChar:   {},
  phrasesByWord: {},
  deck:          [],
  known:         new Set(),
  unknown:       new Set(),
  supaUser:      null,
  userPlan:      'free',
  activeHskLevels: new Set(_initialHsk),
  activeStatuses:  new Set(_initialStatuses),
  gridSort:      'pinyin',
  gridSearch:    '',
  groupsContent: _initialMode,
  slangDeck:     [],
  syncTimer:     null,
  settingsTimer: null,
};
