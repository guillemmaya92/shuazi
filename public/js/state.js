// Restore the last-used game mode synchronously so the boot sequence can put the
// matching data (chars vs words) on the critical path for the first card.
let _initialMode = 'characters';
try { if (localStorage.getItem('shuazi-mode') === 'words') _initialMode = 'words'; } catch (e) {}

export const state = {
  CHARACTERS:    [],
  WORDS:         [],
  PHRASES:       [],
  RADICALS:      [],
  COMPONENTS:    [],
  charsByComponent: {},
  charById:      {},
  wordsByChar:   {},
  phrasesByWord: {},
  deck:          [],
  known:         new Set(),
  unknown:       new Set(),
  supaUser:      null,
  userPlan:      'free',
  activeHskLevels: new Set([1, 2, 3, 4, 5, 6]),
  activeStatuses:  new Set(['left', 'know', 'review']),
  gridSort:      'pinyin',
  gridSearch:    '',
  groupsContent: _initialMode,
  slangDeck:     [],
  syncTimer:     null,
};
