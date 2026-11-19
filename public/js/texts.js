import { t } from './i18n.js';
import { state } from './state.js';
import { hskLabel, supa } from './config.js';
import { isAvailable } from './cards.js';
import { speak, stopSpeaking, ttsPublicUrl, DEFAULT_TTS_VOICE, prefetchTts, unlockAudio } from './translator.js';
import { openWordModal, animateGridWrap, EYE_SVG, EYE_OFF_SVG } from './ui.js';
import { initTextCreate, startTextAudio } from './text-create.js';
import { setupPullRefresh } from './pull-refresh.js';

/* ── TEXTS: graded reading passages ──
   Loaded from the Supabase `texts` table. The list only fetches light columns;
   a passage's `text` is fetched when it is opened. `text` is pre-segmented with
   "|" between words and a line break between paragraphs; it is matched against
   the `words` table and tapping a word opens its detail panel. */
let TEXTS = [];                 // list rows: id, title, title_en, title_es, hsk, position, source
let listState = 'idle';         // idle | loading | ready | error
const bodyCache = new Map();    // id -> passage text
const bodyState = new Map();    // id -> 'loading' | 'error'

async function loadTextList() {
  if (listState === 'loading') return;
  listState = 'loading';
  try {
    await window._supabaseReady;
    const { data, error } = await supa
      .from('texts')
      .select('id, title, title_en, title_es, hsk, position, source, audio_url')
      .eq('published', true)   // admins can also read hidden rows (RLS), so filter explicitly
      .order('hsk').order('position').order('id');   // `id` breaks ties: position may repeat
    if (error) throw error;
    TEXTS = data || [];
    listState = 'ready';
  } catch (e) {
    console.error('texts failed to load:', e);
    listState = 'error';
  }
  refreshTexts();
}

async function loadTextBody(id) {
  const row = TEXTS.find(x => x.id === id);
  if (!row || !isAvailable(row.hsk)) return;   // never fetch a locked passage
  if (bodyState.get(id) === 'loading') return;
  bodyState.set(id, 'loading');
  try {
    await window._supabaseReady;
    const { data, error } = await supa.from('texts').select('text, text_en, text_es, audio_url').eq('id', id).single();
    if (error) throw error;
    bodyCache.set(id, { zh: data.text || '', en: data.text_en || '', es: data.text_es || '', audioUrl: data.audio_url || '' });
    bodyState.delete(id);
  } catch (e) {
    console.error('text failed to load:', e);
    bodyState.set(id, 'error');
  }
  refreshTexts();
}

// Title in the app language (Chinese title stays the main line; this is the gloss).
const glossTitle = x => (state.lang === 'es' ? x.title_es : x.title_en) || x.title_en || x.title_es || '';

// Any line break (single or blank-line separated, real or a literal "\n" typed
// into the database) starts a new paragraph, so dialogues render one line each.
const paragraphsOf = s => String(s).split(/(?:\r?\n|\\n|\u2028|\u2029)+/).map(p => p.trim()).filter(Boolean);

let openId = null;

// Levels whose section is folded. Starts folded, like Groups, and survives
// opening/closing a text.
const collapsedLevels = new Set([1, 2, 3, 4, 5, 6, 7]);

// Underline words in their HSK colour. Persisted; off by default.
let hlOn = false;
try { hlOn = localStorage.getItem('shuazi-text-hl') === '1'; } catch (e) {}
// Pinyin above the characters. Persisted; off by default.
let pyOn = false;
try { pyOn = localStorage.getItem('shuazi-text-py') === '1'; } catch (e) {}
// Background by learning state (known = green, review = blue). Persisted; off by default.
let stOn = false;
try { stOn = localStorage.getItem('shuazi-text-st') === '1'; } catch (e) {}

/* ── Source filter ──
   Same pattern as Radicals / Components in Groups: a "Filters" section with a
   collapsible group of tiles; tapping a tile filters the list to that source
   (tap again to clear), and the other tiles hide while one is active. */
const NO_SOURCE = '__no_source__';   // key for texts without a source
let activeSource = null;             // a source key, or null = all
let sourcesCollapsed = true;
const srcOf = x => (x.source || '').trim();
const srcKey = x => srcOf(x) || NO_SOURCE;

// [{ key, label, count }] — one per distinct source (plus "no source" if any text lacks one).
function sourceOptions(list = TEXTS) {
  const count = new Map();
  list.forEach(x => count.set(srcKey(x), (count.get(srcKey(x)) || 0) + 1));
  const opts = [...count.keys()].filter(k => k !== NO_SOURCE)
    .sort((a, b) => a.localeCompare(b))
    .map(k => ({ key: k, label: k, count: count.get(k) }));
  if (count.has(NO_SOURCE)) opts.push({ key: NO_SOURCE, label: t('texts.srcNone'), count: count.get(NO_SOURCE) });
  return opts;
}

// "Admin" switch (Settings, admins only): the admin buttons ("+" and delete) only
// show while it is on. Persisted; off by default, so a stray tap can't reach them.
let adminDel = false;
try { adminDel = localStorage.getItem('shuazi-admin-del') === '1'; } catch (e) {}
export const getAdminDelete = () => adminDel;
export function setAdminDelete(on) {
  adminDel = !!on;
  try { localStorage.setItem('shuazi-admin-del', adminDel ? '1' : '0'); } catch (e) {}
  refreshTexts();
}

// Admin aid (Admin switch on): a muted speaker next to the title of a text whose audio
// is not published yet — still being generated in the background, or it failed.
const adminTools = () => !!(state.supaUser && state.isAdmin && adminDel);
const NO_AUDIO_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/></svg>';
const noAudioMark = x => adminTools() && !x.audio_url
  ? ` <span title="${esc(t('texts.audioMissing'))}" style="display:inline-flex;vertical-align:-2px;margin-left:4px;color:var(--faint)">${NO_AUDIO_SVG}</span>`
  : '';
const audioStartedIds = new Set();   // texts whose audio was started this session (hides the button)

/* ── Audio status ──
   The audio is built on the server in the background and `texts.audio_url` is only
   filled when it is complete, but the app reads that column once (list load / opening
   a text). So: (1) texts whose audio was just started are polled until it shows up,
   and (2) admins re-check the texts still missing audio whenever the list is shown. */
const audioWatch = new Set();        // ids being polled
let audioWatchSince = 0;
let audioTimer = null;
let lastAudioCheck = 0;
const AUDIO_POLL_MS = 4000;
const AUDIO_WATCH_MAX_MS = 5 * 60 * 1000;   // give up after 5 minutes

// Applies fresh audio_url values to the list rows, the cached bodies and the UI.
function applyAudioUrls(rows) {
  let changed = false;
  for (const r of rows || []) {
    if (!r.audio_url) continue;
    audioWatch.delete(r.id);
    const row = TEXTS.find(x => x.id === r.id);
    if (row && !row.audio_url) { row.audio_url = r.audio_url; changed = true; }
    const doc = bodyCache.get(r.id);
    if (doc && doc.audioUrl !== r.audio_url) {   // forget the old "no audio" answer
      doc.audioUrl = r.audio_url;
      delete doc.clips; delete doc.speakers;
    }
  }
  if (!changed) return;
  if (openId == null) refreshTexts();   // list: the "no audio" mark disappears
  else {                                // reader: don't re-render it mid-reading, just hide the button
    const btn = document.getElementById('textsAudioBtn');
    if (btn) btn.style.display = 'none';
  }
}

async function pollAudio() {
  audioTimer = null;
  if (!audioWatch.size) return;
  try {
    await window._supabaseReady;
    const { data } = await supa.from('texts').select('id, audio_url').in('id', [...audioWatch]);
    applyAudioUrls(data);
  } catch (e) { /* try again on the next tick */ }
  if (audioWatch.size && Date.now() - audioWatchSince < AUDIO_WATCH_MAX_MS) audioTimer = setTimeout(pollAudio, AUDIO_POLL_MS);
  else audioWatch.clear();
}

function watchTextAudio(id) {
  audioWatch.add(id);
  audioWatchSince = Date.now();
  if (!audioTimer) audioTimer = setTimeout(pollAudio, AUDIO_POLL_MS);
}

// Admin: when the list is shown, look again at the texts that still have no audio
// (throttled, and only repaints if something actually changed).
async function refreshMissingAudio() {
  if (!adminTools() || Date.now() - lastAudioCheck < 15000) return;
  const ids = TEXTS.filter(x => !x.audio_url).map(x => x.id).slice(0, 200);
  if (!ids.length) return;
  lastAudioCheck = Date.now();
  try {
    await window._supabaseReady;
    const { data } = await supa.from('texts').select('id, audio_url').in('id', ids);
    applyAudioUrls(data);
  } catch (e) { /* not critical */ }
}

async function startOpenTextAudio() {
  const row = TEXTS.find(x => x.id === openId);
  if (!row || !adminTools()) return;
  const btn = document.getElementById('textsAudioBtn');
  if (btn) btn.disabled = true;
  try {
    await startTextAudio(row.id);
    audioStartedIds.add(row.id);
    watchTextAudio(row.id);
    window.alert(t('texts.audioStartedLater'));
  } catch (e) {
    console.error('text audio start failed:', e);
    window.alert(`${t('texts.audioStartError')}\n${e.message || ''}`);
  } finally {
    renderTexts();
  }
}

/* ── Search ──
   The magnifier in the header opens a search field. It matches the Chinese title plus
   the title in the app language: title + title_es when the app is in Spanish,
   title + title_en otherwise. Case and accents are ignored; every word typed must
   appear. While searching, the level sections open so the matches are visible. */
let textQuery = '';
const normQ = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function matchesQuery(x) {
  const terms = normQ(textQuery).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  // Chinese title + the title in the app language (the one shown under it).
  const hay = normQ(`${x.title} ${state.lang === 'es' ? x.title_es : x.title_en}`);
  return terms.every(term => hay.includes(term));
}

/* ── Sort ──
   The header button cycles the order of the texts INSIDE each HSK level (the levels
   stay grouped): "Id" (by the `position` field, ties by id), A–Z by the title in the
   app language, newest first, unread first. Persisted. */
const SORT_MODES = ['id', 'az', 'new', 'unread'];
let textSort = 'id';
try { const s = localStorage.getItem('shuazi-text-sort'); if (SORT_MODES.includes(s)) textSort = s; } catch (e) {}
const sortLabelOf = mode => t('texts.sort.' + mode);

function sortTexts(list) {
  const arr = [...list];   // `list` comes ordered by hsk, position, id; every mode below sorts explicitly
  if (textSort === 'id') {
    // The "Id" mode follows the `position` field (ties by id), so editing `position`
    // reorders the list.
    arr.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0) || a.id - b.id);
  } else if (textSort === 'az') {
    const key = x => (state.lang === 'es' ? x.title_es : x.title_en) || x.title || '';
    arr.sort((a, b) => key(a).localeCompare(key(b), state.lang === 'es' ? 'es' : 'en', { sensitivity: 'base' }));
  } else if (textSort === 'new') {
    arr.sort((a, b) => b.id - a.id);   // ids grow with every insert
  } else if (textSort === 'unread') {
    // Unread first: texts marked "read" go last; "review" stays with the pending ones.
    const done = x => (textState.get(x.id) === 'read' ? 1 : 0);
    arr.sort((a, b) => done(a) - done(b)
      || Number(a.position ?? 0) - Number(b.position ?? 0) || a.id - b.id);
  }
  return arr;
}

function wireTextSort() {
  const btn = document.getElementById('textsSortBtn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    textSort = SORT_MODES[(SORT_MODES.indexOf(textSort) + 1) % SORT_MODES.length];
    try { localStorage.setItem('shuazi-text-sort', textSort); } catch (e) {}
    renderTexts();
  });
}

/* ── Pull down to clear the filters ──
   Same gesture and animation as Groups (shared pull-refresh.js): pull down from the top
   of the list and release. It clears the filters of this screen — the source filter and
   the search — and folds the Source group. The Profile filters (HSK level, status) are
   settings of the whole app and are left alone, as in Groups. */
function clearTextFilters() {
  activeSource = null;
  sourcesCollapsed = true;
  textQuery = '';
  const wrap = document.getElementById('textsSearchWrap');
  const btn  = document.getElementById('textsSearchBtn');
  const inp  = document.getElementById('textsSearchInput');
  wrap?.classList.remove('open');
  btn?.classList.remove('active');
  btn?.setAttribute('aria-pressed', 'false');
  if (inp) inp.value = '';
  renderTexts();
}

let textsPullWired = false;
function wireTextsPull() {
  if (textsPullWired) return;
  textsPullWired = true;
  setupPullRefresh({
    scroll:    document.getElementById('texts-scroll'),
    disc:      document.getElementById('textsPull'),
    content:   document.getElementById('textsPullFollow'),
    onRefresh: clearTextFilters,
    exitUp:    true,
    haptic:    () => navigator.vibrate?.(12),
    trigger:   96,
    max:       132,
    damp:      120,
    label:     document.getElementById('textsPullLabel'),
    pullText:  () => t('filters.pullClear'),
    readyText: () => t('filters.releaseClear'),
    // Only on the list: inside an open text a downward pull must not clear anything.
    enabled:   () => !document.body.classList.contains('reader-open'),
  });
}

function wireTextSearch() {
  const btn   = document.getElementById('textsSearchBtn');
  const wrap  = document.getElementById('textsSearchWrap');
  const input = document.getElementById('textsSearchInput');
  const clear = document.getElementById('textsSearchClear');
  if (!btn || !wrap || !input || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  const sync = () => { btn.classList.toggle('active', wrap.classList.contains('open')); btn.setAttribute('aria-pressed', String(wrap.classList.contains('open'))); };
  btn.addEventListener('click', () => {
    const open = wrap.classList.toggle('open');
    sync();
    if (open) input.focus();
    else { input.value = ''; textQuery = ''; renderTexts(); }
  });
  input.addEventListener('input', () => { textQuery = input.value; renderTexts(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });   // hide the phone keyboard
  clear.addEventListener('click', () => { input.value = ''; textQuery = ''; renderTexts(); input.focus(); });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ── Tokenizer ──
   Text segmented with "|" is used as-is (see SEP). Otherwise: forward maximum
   matching against state.WORDS: at each Han character take the
   longest word in the table that starts there. Anything else (punctuation,
   digits, Latin, unknown Han) passes through as plain text. */
const HAN = /\p{Script=Han}/u;
let _lookup = null, _lookupSrc = null, _maxLen = 1;

function wordLookup() {
  const src = state.WORDS;
  if (!src || !src.length) return null;
  if (_lookup && _lookupSrc === src && _lookup.size) return _lookup;
  _lookup = new Map();
  _lookupSrc = src;
  _maxLen = 1;
  for (const w of src) {
    const key = w.word;
    if (!key) continue;
    const prev = _lookup.get(key);
    // Homographs: keep the most frequent entry.
    if (!prev || (w.frequency ?? 0) > (prev.frequency ?? 0)) _lookup.set(key, w);
    const n = [...key].length;
    if (n > _maxLen) _maxLen = n;
  }
  return _lookup;
}

// Pre-segmented text: "|" marks word boundaries, so no guessing is needed —
// each chunk is simply looked up in `words`. Plain text without any "|" falls
// back to the automatic segmentation below.
const SEP = '|';

export function tokenize(str) {
  const map = wordLookup();
  if (str.includes(SEP)) {
    return str.split(SEP).filter(Boolean)
      .map(chunk => (map && map.has(chunk)) ? { text: chunk, word: map.get(chunk) } : { text: chunk });
  }
  const chars = [...str];
  const out = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ text: plain }); plain = ''; } };

  for (let i = 0; i < chars.length;) {
    if (map && HAN.test(chars[i])) {
      let hit = null;
      for (let n = Math.min(_maxLen, chars.length - i); n >= 1; n--) {
        const cand = chars.slice(i, i + n).join('');
        if (map.has(cand)) { hit = { text: cand, word: map.get(cand) }; break; }
      }
      if (hit) {
        flush();
        out.push(hit);
        i += [...hit.text].length;
        continue;
      }
    }
    plain += chars[i++];
  }
  flush();
  return out;
}

// Han characters outside `words` still get pinyin from the characters table.
function plainHTML(text) {
  return [...text].map(ch => {
    const py = HAN.test(ch) ? state.CHARACTERS?.find(c => c.char === ch)?.pinyin : null;
    return py ? `<span class="tx-c">${esc(ch)}<span class="tx-p" aria-hidden="true">${esc(py)}</span></span>` : esc(ch);
  }).join('');
}

// Word pinyin is placed one syllable per character when the counts match
// ("zǎo fàn" over 早饭), so long pinyin never spills over the next word.
// Otherwise (儿化, apostrophes…) it is centred over the whole word.
function wordInnerHTML(text, pinyin) {
  const chars = [...text];
  const syl   = String(pinyin ?? '').trim().split(/\s+/).filter(Boolean);
  if (chars.length > 1 && syl.length === chars.length) {
    return `<span class="tx-b">${chars.map((c, i) =>
      `<span class="tx-c">${esc(c)}<span class="tx-p" aria-hidden="true">${esc(syl[i])}</span></span>`).join('')}</span>`;
  }
  return `<span class="tx-b">${esc(text)}</span><span class="tx-p" aria-hidden="true">${esc(pinyin ?? '')}</span>`;
}

function tokenHTML(tok) {
  return tok.word
    ? `<span class="tx-w tx-h${tok.word.hsk ?? 0}${state.known.has(tok.text) ? ' tx-known' : state.unknown.has(tok.text) ? ' tx-review' : ''}" data-w="${esc(tok.text)}">${wordInnerHTML(tok.text, tok.word.pinyin)}</span>`
    : tok.han ? `<span class="tx-u">${plainHTML(tok.text)}</span>`
    : plainHTML(tok.text);
}

/* ── Sentences ──
   A Chinese sentence ends at 。！？ (plus any closing quotes/brackets right
   after it). Translations are split the same way on . ! ? and matched to the
   Chinese sentences of the same paragraph by position. */
const ZH_END  = /^[。！？!?…]$/;
const CLOSERS = /^[”’」』）)》\]"']$/;

function sentencesOf(tokens) {
  // Plain (non-word) chunks are split per character so punctuation inside them
  // can end a sentence. Rendering is unchanged: plainHTML is per character anyway.
  // Runs of Han characters stay together (one `han` token, e.g. a name not in
  // `words`) so they can be lit as a unit while the text is read aloud.
  const toks = tokens.flatMap(t => t.word ? [t]
    : (t.text.match(/\p{Script=Han}+|[^\p{Script=Han}]/gu) || [])
        .map(c => HAN.test(c) ? { text: c, han: true } : { text: c }));
  const out = [];
  let cur = [], ended = false;
  for (const tok of toks) {
    if (ended && !CLOSERS.test(tok.text) && !ZH_END.test(tok.text)) { out.push(cur); cur = []; ended = false; }
    cur.push(tok);
    if (ZH_END.test(tok.text)) ended = true;
  }
  if (cur.length) out.push(cur);
  return out;
}

// "|" in a translated paragraph marks sentence boundaries explicitly (one piece
// per Chinese sentence). Without it, the paragraph is split on . ! ? instead.
function splitTranslation(p) {
  if (String(p).includes(SEP)) return String(p).split(SEP).map(s => s.trim()).filter(Boolean);
  return (String(p).match(/[^.!?…]+(?:[.!?…]+["”’)»\]]*|$)/g) || [])
    .map(s => s.trim()).filter(Boolean);
}

function paragraphHTML(p, pi) {
  const sents = sentencesOf(tokenize(p));
  return `<p data-p="${pi}" data-n="${sents.length}">`
    + sents.map((s, si) => `<span class="tx-s" data-s="${si}">${s.map(tokenHTML).join('')}</span>`).join('')
    + '</p>';
}

// Translation of the text in the app language (falls back to the other one).
function translationOf(doc) {
  return (state.lang === 'es' ? doc.es : doc.en) || doc.en || doc.es || '';
}

// Translation for sentence `si` of paragraph `pi`. When the translated paragraph
// has a different number of sentences, the whole paragraph is returned instead.
function sentenceTranslation(doc, pi, si, n) {
  const para = paragraphsOf(translationOf(doc))[pi];
  if (!para) return null;
  const sents = splitTranslation(para);
  return sents.length === n ? { text: sents[si], whole: false } : { text: para, whole: true };
}

function paintTr(html, empty) {
  const box = document.getElementById('textsTr');
  if (!box) return;
  box.classList.toggle('empty', !!empty);
  box.innerHTML = html;
  box.style.display = '';
}

// True while a reader with a translation is open: the box then stays visible on
// the Chinese page, showing a hint until a sentence is long-pressed.
let trAvailable = false;

// Back to the idle state: the hint on the Chinese page, hidden otherwise
// (no translation, list view, or the full-translation page).
// Shows the translation of sentence `si` of paragraph `pi` in the box (used by
// the read-aloud queue, and to restore a selected sentence when it stops).
function paintSentenceTr(pi, si) {
  if (!trAvailable) return;
  const doc = openId != null ? bodyCache.get(openId) : null;
  const pEl = document.querySelector(`#texts-content .tx-page-zh p[data-p="${pi}"]`);
  if (!doc || !pEl) return;
  const tr = sentenceTranslation(doc, pi, si, Number(pEl.dataset.n));
  paintTr(esc(tr ? tr.text : t('texts.trNone')), !tr);
}

// Back to the box's idle content: the selected sentence's translation if any,
// otherwise the hint.
function restoreTr() {
  const sel = document.querySelector('#texts-content .tx-s.sel');
  const pEl = sel?.closest('p');
  if (pEl) paintSentenceTr(Number(pEl.dataset.p), Number(sel.dataset.s));
  else hideTr();
}

function hideTr() {
  const box = document.getElementById('textsTr');
  if (!box) return;
  // The box lives inside the Chinese page, so it never shows over the translation.
  if (trAvailable) return paintTr(esc(t('texts.trHint')), true);
  box.style.display = 'none'; box.innerHTML = '';
}

/* ── Full-translation page ──
   Swipe left on the reader to slide in the whole translation (it sits to the
   right of the Chinese); swipe right to return. Horizontal drags only (touch-action: pan-y keeps
   vertical scrolling native). */
let trPage   = false;   // true while the translation page is shown
let pagerFor = null;    // text id the pager state belongs to

// The two pages share one scroll container but behave as separate pages: the
// translation always opens at its top, and the Chinese page comes back to where
// the user left it. While both are laid out (dragging / sliding), the incoming
// page is shifted so it already shows at its own scroll position.
let zhScroll = 0;
// Track offset that shows the translation page (accounts for the --tx-gap gutter).
const TR_OFFSET = 'calc(-50% - var(--tx-gap) / 2)';
const readerScroll = () => document.getElementById('texts-scroll');

function alignIncoming(pager) {
  const sc = readerScroll();
  if (!sc) return;
  if (!trPage) zhScroll = sc.scrollTop;                  // remember where Chinese was left
  const other  = pager.querySelector(trPage ? '.tx-page-zh' : '.tx-page-tr');
  const target = trPage ? zhScroll : 0;
  const shift  = sc.scrollTop - target;
  other.style.transform = `translateY(${shift}px)`;
  // The sticky box is stuck relative to the current scroll, so undo the page
  // shift on it to keep it at the top of the incoming Chinese page.
  if (trPage) {
    const box = other.querySelector('.texts-tr');
    if (box) box.style.transform = `translateY(${-shift}px)`;
  }
}

function setPage(pager, toTr, animate = true) {
  const from = trPage;
  const track = pager.querySelector('.tx-track');
  const pages = pager.querySelectorAll('.tx-page');
  if (from !== toTr && !pages[0].style.transform && !pages[1].style.transform) {
    pages.forEach(p => p.classList.remove('off'));
    alignIncoming(pager);                                  // programmatic flip (no drag)
  }
  trPage = toTr;
  pages.forEach(p => p.classList.remove('off'));               // both laid out while moving
  track.classList.toggle('dragging', !animate);
  track.style.transform = toTr ? `translateX(${TR_OFFSET})` : 'translateX(0)';
  const settle = () => {
    // Collapse the hidden page so the scroll height follows the visible one,
    // then drop the alignment shift and jump to the page's own position.
    pager.querySelector(toTr ? '.tx-page-zh' : '.tx-page-tr').classList.add('off');
    pages.forEach(p => { p.style.transform = ''; });
    const box = pager.querySelector('.texts-tr');
    if (box) box.style.transform = '';
    const sc = readerScroll();
    if (sc && from !== toTr) sc.scrollTop = toTr ? 0 : zhScroll;
  };
  if (animate) {
    // transitionend can be skipped (interrupted / no movement), so a timeout backs it up.
    let fired = false;
    const once = () => { if (fired) return; fired = true; track.removeEventListener('transitionend', onEnd); if (trPage === toTr) settle(); };
    const onEnd = e => { if (e.target === track) once(); };
    track.addEventListener('transitionend', onEnd);
    setTimeout(once, 400);
  } else settle();
  clearSentence();   // hidden over the full translation; back to the hint on the Chinese page
}

// Back to the texts list from a swipe. The click that the browser may fire right
// after the gesture is swallowed so it can't open a text in the freshly drawn list.
function swipeBack() {
  const eat = e => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 400);
  closeText();
}

// Texts without a translation have no pager: a plain right swipe goes back.
// #texts-content survives re-renders, so this is wired once and only acts while
// a reader without pager is shown.
let swipeBackWired = false;
function wireSwipeBack(host) {
  if (swipeBackWired) return;
  swipeBackWired = true;
  let dx = 0;
  horizontalSwipe(host, {
    accept: () => host.classList.contains('texts-reader') && !host.querySelector('.tx-pager'),
    start:  () => { host.style.transition = 'none'; },
    move:   mx => { dx = mx > 0 ? mx : mx * 0.25; host.style.transform = `translateX(${dx}px)`; },
    end:    (vx, cancelled) => {
      suppressTap = true;
      host.style.transition = 'transform .25s ease';
      host.style.transform = '';
      if (!cancelled && isFlip(dx, vx, host.offsetWidth) && dx > 0) { host.style.transition = ''; swipeBack(); }
    },
  });
}

/* ── Horizontal swipe detection (shared by the pager and swipe-back) ──
   touch-action: pan-y leaves vertical scrolling to the browser, which picks its
   axis by comparing |dx| and |dy| — so we use the same plain comparison (no
   extra ratio that would leave a "dead" diagonal where neither moves). If the
   browser takes the gesture for scrolling anyway it sends pointercancel: the
   drag then snaps back instead of being treated as a release. A gesture first
   read as vertical but that keeps coming (so the browser didn't scroll) and
   turns clearly sideways is promoted to a horizontal drag. */
function horizontalSwipe(el, { accept, start, move, end }) {
  let id = null, sx = 0, sy = 0, axis = null, lastX = 0, lastT = 0, vx = 0;
  el.addEventListener('pointerdown', e => {
    id = null;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (accept && !accept()) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; axis = null;
    lastX = e.clientX; lastT = e.timeStamp; vx = 0;
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (axis !== 'x') {
      if (!axis) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      } else if (Math.abs(mx) > 24 && Math.abs(mx) > Math.abs(my) * 1.5) {
        axis = 'x'; sx = e.clientX;   // promoted: start from here, no jump
      }
      if (axis !== 'x') return;
      try { el.setPointerCapture(id); } catch (err) {}
      start();
    }
    // Velocity (px/ms), smoothed, for flick detection on release.
    const dt = e.timeStamp - lastT;
    if (dt > 0) vx = vx * 0.6 + ((e.clientX - lastX) / dt) * 0.4;
    lastX = e.clientX; lastT = e.timeStamp;
    move(e.clientX - sx);
  });
  const finish = cancelled => e => {
    if (e.pointerId !== id) return;
    id = null;
    if (axis !== 'x') return;
    // A finger that stopped before lifting isn't a flick.
    if (e.timeStamp - lastT > 80) vx = 0;
    end(vx, cancelled);
  };
  el.addEventListener('pointerup', finish(false));
  el.addEventListener('pointercancel', finish(true));
}

// Page change: dragged past ~22% of the width (max 80px), or a quick flick of
// at least 24px in the same direction.
function isFlip(dx, vx, width) {
  const w = width || 1;
  return Math.abs(dx) > Math.min(80, w * 0.22)
    || (Math.abs(dx) > 24 && Math.abs(vx) > 0.45 && Math.sign(vx) === Math.sign(dx));
}

function wirePager(pager) {
  if (!pager) return;
  const track = pager.querySelector('.tx-track');
  setPage(pager, trPage, false);
  let dx = 0;
  horizontalSwipe(pager, {
    start: () => {
      dx = 0;
      pager.querySelectorAll('.tx-page').forEach(p => p.classList.remove('off'));
      alignIncoming(pager);
      track.classList.add('dragging');
    },
    move: mx => {
      // Rubber-band past the translation page; on the Chinese page a drag to the
      // right follows the finger freely (it's the "back to the list" gesture).
      dx = (trPage && mx < 0) ? mx * 0.25 : mx;
      track.style.transform = `translateX(calc(${trPage ? TR_OFFSET : '0%'} + ${dx}px))`;
    },
    end: (vx, cancelled) => {
      suppressTap = true;   // the click that ends a drag must not open a word
      // Browser took over (scrolling) or the system cancelled: snap back.
      if (cancelled) return setPage(pager, trPage, true);
      const flip = isFlip(dx, vx, pager.offsetWidth);
      if (!trPage && flip && dx > 0) return swipeBack();
      const toTr = trPage ? !(flip && dx > 0) : (flip && dx < 0);
      setPage(pager, toTr, true);
    },
  });
}

// Deselect the sentence and hide the translation box.
function clearSentence() {
  const host = document.getElementById('texts-content');
  host?.querySelectorAll('.tx-s.sel').forEach(x => x.classList.remove('sel'));
  // While reading aloud the box keeps following the sentence being read.
  const p = listening && readingSentEl?.isConnected ? readingSentEl.closest('p') : null;
  if (p) paintSentenceTr(Number(p.dataset.p), Number(readingSentEl.dataset.s));
  else hideTr();
}

// A tap anywhere on the Texts screen outside the selected sentence clears it
// (capture phase, so it runs before the reader's own click handler; the click
// that ends a long-press is skipped). Wired once.
let outsideTapWired = false;
function wireOutsideTap() {
  if (outsideTapWired) return;
  const screen = document.getElementById('screen-texts');
  if (!screen) return;
  outsideTapWired = true;
  // A new touch anywhere starts fresh (a long-press on mobile may not be
  // followed by a click, which would leave the flag set).
  screen.addEventListener('pointerdown', () => { suppressTap = false; }, true);
  screen.addEventListener('click', e => {
    if (suppressTap) return;
    if (!e.target.closest('.tx-s.sel')) clearSentence();
  }, true);
}

// Long-press a sentence (450ms, like the Groups tiles) to show its translation
// in the panel above the text; long-press it again to hide it. A normal tap
// still opens the word panel.
let suppressTap = false;
function wireSentencePress(host, doc) {
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  host.onpointerdown = e => {
    suppressTap = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const sEl = e.target.closest('.tx-s');
    if (!sEl) return;
    sx = e.clientX; sy = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressTap = true;   // eat the click that follows the long-press
      if (navigator.vibrate) navigator.vibrate(30);
      if (sEl.classList.contains('sel')) { clearSentence(); return; }   // second long-press hides it
      const pEl = sEl.closest('p');
      const tr  = sentenceTranslation(doc, Number(pEl.dataset.p), Number(sEl.dataset.s), Number(pEl.dataset.n));
      host.querySelectorAll('.tx-s.sel').forEach(x => x.classList.remove('sel'));
      if (tr && tr.whole) pEl.querySelectorAll('.tx-s').forEach(x => x.classList.add('sel'));
      else sEl.classList.add('sel');
      paintTr(esc(tr ? tr.text : t('texts.trNone')), !tr);
      // Whole-paragraph selection (translation not split per sentence) reads from its start.
      listenFromSelection(Number(pEl.dataset.p), tr && tr.whole ? 0 : Number(sEl.dataset.s));
    }, 450);
  };
  host.onpointermove = e => {
    if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
  };
  host.onpointerup = cancel;
  host.onpointercancel = cancel;
  host.oncontextmenu = e => { if (e.target.closest('.tx-s')) e.preventDefault(); };
}

function onWordTap(e) {
  const el = e.target.closest('.tx-w');
  if (!el) return;
  const w = _lookup && _lookup.get(el.dataset.w);
  if (w) openWordModal(w);
}

/* ── Read tracking ──
   Study state of each text: 'read' (green) or 'review' (blue, "repaso"); no entry =
   not marked. Same cycle as the tiles in Groups: not marked → read → review → not
   marked. Kept in localStorage (works signed out) and mirrored to `text_progress`
   (column `state`) when signed in. */
const READ_KEY = 'shuazi-texts-read';          // old format: [id, id, …] (all "read")
const STATE_KEY = 'shuazi-texts-progress';     // { "<id>": "read" | "review" }
const textState = new Map();                    // id -> 'read' | 'review'
try {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) {
    Object.entries(JSON.parse(raw)).forEach(([id, st]) => { if (st === 'read' || st === 'review') textState.set(Number(id), st); });
  } else {
    // First run after this change: the old list of read ids becomes "read".
    JSON.parse(localStorage.getItem(READ_KEY) || '[]').forEach(id => textState.set(Number(id), 'read'));
  }
} catch (e) {}
let readSyncedFor = null;   // user id whose server rows have been merged in

const TEXT_STATES = ['read', 'review'];
// The status key the Profile filters use for a text (same keys as words: left / know / review).
const textStatusKey = id => { const st = textState.get(id); return st === 'read' ? 'know' : st === 'review' ? 'review' : 'left'; };
const nextTextState = st => (st === 'read' ? 'review' : st === 'review' ? null : 'read');
const countRead = ids => ids.filter(id => textState.get(id) === 'read').length;

function saveReadLocal() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(Object.fromEntries(textState))); } catch (e) {}
}

// Once per signed-in user: merge the server's rows into the local map and push
// any local-only marks up, then repaint the list. If both sides have the text, the
// server's state wins.
async function syncReadFromServer() {
  const uid = state.supaUser?.id;
  if (!uid || readSyncedFor === uid) return;
  readSyncedFor = uid;
  try {
    const { data, error } = await supa.from('text_progress').select('text_id, state').eq('user_id', uid);
    if (error) throw error;
    const remote = new Map((data || []).filter(r => TEXT_STATES.includes(r.state)).map(r => [r.text_id, r.state]));
    const localOnly = [...textState].filter(([id]) => !remote.has(id));
    remote.forEach((st, id) => textState.set(id, st));
    saveReadLocal();
    if (localOnly.length) {
      await supa.from('text_progress').upsert(
        localOnly.map(([text_id, st]) => ({ user_id: uid, text_id, state: st, updated_at: new Date().toISOString() })),
        { onConflict: 'user_id,text_id' });
    }
    refreshTexts();
  } catch (e) {
    console.error('text progress sync failed:', e);
    readSyncedFor = null;
  }
}

const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const REVIEW_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>';

// The button at the end of an open text: shows the current state, tap cycles it.
function paintDoneBtn(btn, id) {
  if (!btn) return;
  const st = textState.get(id) || null;
  btn.classList.toggle('active', st === 'read');
  btn.classList.toggle('review', st === 'review');
  btn.setAttribute('aria-pressed', String(st !== null));
  btn.innerHTML = (st === 'read' ? CHECK_SVG : st === 'review' ? REVIEW_SVG : '')
    + `<span>${esc(t(st === 'read' ? 'texts.markedRead' : st === 'review' ? 'texts.markedReview' : 'texts.markRead'))}</span>`;
}

async function toggleRead(id, btn) {
  const next = nextTextState(textState.get(id));
  if (next) textState.set(id, next); else textState.delete(id);
  saveReadLocal();
  paintDoneBtn(btn, id);
  const uid = state.supaUser?.id;
  if (!uid) return;
  try {
    const q = next
      ? supa.from('text_progress').upsert({ user_id: uid, text_id: id, state: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id,text_id' })
      : supa.from('text_progress').delete().eq('user_id', uid).eq('text_id', id);
    const { error } = await q;
    if (error) throw error;
  } catch (e) {
    // 'review' needs the text_progress.state check to allow it (scripts/supabase_texts.sql).
    console.error('text progress save failed:', e);
  }
}

// After a long-press in the list: recolor the item and refresh its level's
// "n/m read" count and both progress bars without re-rendering.
function paintListItem(btn, id) {
  const st = textState.get(id);
  btn.classList.toggle('read', st === 'read');
  btn.classList.toggle('review', st === 'review');
  const group = btn.closest('.hsk-group');
  if (!group) return;
  const ids   = [...group.querySelectorAll('.texts-item')].map(el => Number(el.dataset.id));
  const readN = countRead(ids);
  const pct   = ids.length ? Math.round(readN / ids.length * 100) : 0;
  const count = group.querySelector('.hsk-group-label .count');
  if (count) count.textContent = `${readN}/${ids.length} ${t('texts.read')}`;
  group.querySelectorAll('.hsk-prog-fill, .hsk-full-bar-fill').forEach(f => { f.style.width = pct + '%'; });
}
// Same eye icons as the Groups pinyin toggle, but highlighted when ON (like the
// other reader toggles): open eye + highlighted = pinyin shown, crossed eye = hidden.
function syncPyBtn() {
  const btn = document.getElementById('textsPyBtn');
  if (!btn) return;
  btn.innerHTML = pyOn ? EYE_SVG : EYE_OFF_SVG;
  btn.classList.toggle('active', pyOn);
  btn.setAttribute('aria-pressed', String(pyOn));
}

export function renderTexts() {
  const host   = document.getElementById('texts-content');
  const back   = document.getElementById('textsBack');
  const title  = document.getElementById('textsTitle');
  const sub    = document.getElementById('textsSub');
  const scroll = document.getElementById('texts-scroll');
  const hlBtn  = document.getElementById('textsHlBtn');
  const pyBtn  = document.getElementById('textsPyBtn');
  const stBtn  = document.getElementById('textsStBtn');
  if (!host) return;
  // Reset the reader-only handlers; the reader branch re-wires them.
  host.onpointerdown = host.onpointermove = host.onpointerup = host.onpointercancel = host.oncontextmenu = null;
  trAvailable = false;   // the translation box is re-created inside the Chinese page

  let text = openId != null ? TEXTS.find(x => x.id === openId) : null;
  if (text && !isAvailable(text.hsk)) text = null;   // locked level (e.g. plan changed): never open
  if (openId != null && !text) openId = null;   // list changed under us
  back.style.display = text ? '' : 'none';
  wireTextsPull();
  // Sort + search: only in the list view (an open text hides them).
  wireTextSort();
  const sortBtn = document.getElementById('textsSortBtn');
  if (sortBtn) {
    sortBtn.style.display = text ? 'none' : '';
    const lbl = document.getElementById('textsSortLabel');
    if (lbl) lbl.textContent = sortLabelOf(textSort);
  }
  wireTextSearch();
  const searchBtn  = document.getElementById('textsSearchBtn');
  const searchWrap = document.getElementById('textsSearchWrap');
  if (searchBtn)  searchBtn.style.display  = text ? 'none' : '';
  if (searchWrap) searchWrap.style.display = text ? 'none' : '';
  // "+" (new text from a photo): list view only, admins only (profiles.is_admin).
  const addBtn = document.getElementById('textsAddBtn');
  if (addBtn) {
    addBtn.style.display = !text && state.supaUser && state.isAdmin && adminDel ? '' : 'none';
    if (!addBtn.dataset.wired) {
      addBtn.dataset.wired = '1';
      initTextCreate(addBtn, id => { listState = 'idle'; if (id != null) watchTextAudio(id); renderTexts(); });
    }
  }
  // Delete (open text, admins only).
  const delBtn = document.getElementById('textsDelBtn');
  if (delBtn) {
    delBtn.style.display = text && state.supaUser && state.isAdmin && adminDel ? '' : 'none';
    delBtn.onclick = deleteOpenText;
  }
  // Generate / retry audio (open text without published audio, admins only).
  const audioBtn = document.getElementById('textsAudioBtn');
  if (audioBtn) {
    audioBtn.style.display = text && adminTools() && !text.audio_url && !audioStartedIds.has(text.id) ? '' : 'none';
    audioBtn.disabled = false;
    audioBtn.onclick = startOpenTextAudio;
  }
  hlBtn.style.display = text ? '' : 'none';
  pyBtn.style.display = text ? '' : 'none';
  stBtn.style.display = text ? '' : 'none';
  // Reader mode: the bottom tab bar is replaced by the play button.
  setReaderMode(!!text);
  if (!text) stopTextAudio();
  else syncListenBtn();
  stBtn.classList.toggle('active', stOn);
  stBtn.setAttribute('aria-pressed', String(stOn));
  syncPyBtn();
  hlBtn.classList.toggle('active', hlOn);
  hlBtn.setAttribute('aria-pressed', String(hlOn));

  if (!text) {
    title.textContent = t('texts.title');
    sub.textContent   = t('texts.sub');
    sub.style.display = '';
    host.className = 'texts-list';
    host.onclick = null;
    if (listState === 'idle') loadTextList();
    syncReadFromServer();
    if (listState === 'idle' || listState === 'loading') {
      host.innerHTML = `<div class="texts-msg">${esc(t('texts.loading'))}</div>`;
      return;
    }
    if (listState === 'error') {
      host.innerHTML = `<div class="texts-msg">${esc(t('texts.error'))}</div>`;
      host.onclick = () => { listState = 'idle'; renderTexts(); };
      return;
    }
    if (!TEXTS.length) {
      host.innerHTML = `<div class="texts-msg">${esc(t('texts.empty'))}</div>`;
      return;
    }
    refreshMissingAudio();   // admin: pick up audio that finished in the background
    // Filters → Source (only when there is something to choose between).
    // Profile → Filters → HSK applies here too: levels the user switched off are hidden
    // (locked levels still show their lock placeholder, same rule as Groups).
    // Profile → Filters → status (Faltan / Hecho / Repaso) applies too. A text has the same
    // three states as a word: not marked = left, read = know (hecho), review = review.
    const byHsk = TEXTS.filter(x => !isAvailable(x.hsk)
      || (state.activeHskLevels.has(x.hsk) && state.activeStatuses.has(textStatusKey(x.id))));
    const srcOpts = sourceOptions(byHsk);
    if (activeSource && !srcOpts.some(o => o.key === activeSource)) activeSource = null;   // source vanished
    // Search by title. Locked levels are left out of the results: their titles are never shown.
    const searching = !!normQ(textQuery).trim();
    const visible = byHsk.filter(x => (!activeSource || srcKey(x) === activeSource)
      && (!searching || (isAvailable(x.hsk) && matchesQuery(x))));
    const filtersHTML = srcOpts.length < 2 ? '' : `
      <div class="groups-section-title">
        <div class="groups-section-titletext">${esc(t('groups.filtersTitle'))}<span class="groups-section-sub">${esc(t('texts.srcHint'))}</span></div>
      </div>
      <div class="hsk-group" id="textsSrcGroup">
        <div class="hsk-group-header">
          <div class="hsk-group-label">
            <span class="badge srcbadge">${esc(t('badge.source'))}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--faint);flex-shrink:0" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
            <span class="count">${srcOpts.length} ${esc(t('count.sources'))}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <svg class="chevron ${sourcesCollapsed ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="char-grid-wrap ${sourcesCollapsed ? 'collapsed' : ''}">
          <div class="char-grid source-grid${activeSource ? ' source-filtered' : ''}">${srcOpts.map(o => `
            <button class="char-tile source-tile${o.key === activeSource ? ' active' : ''}" type="button" data-src="${esc(o.key)}" aria-pressed="${o.key === activeSource}">
              <div class="tc">${esc(o.label)}</div><div class="tp">(${o.count})</div>
            </button>`).join('')}
          </div>
        </div>
      </div>`;
    const levels = [...new Set(visible.map(x => x.hsk))].sort((a, b) => a - b);
    // Same collapsible HSK sections as the Groups screen (shared classes + animation).
    const sectionTitleHTML = `
      <div class="groups-section-title">
        <div class="groups-section-titletext">${esc(t('texts.sectionTitle'))}<span class="groups-section-sub">${esc(t('texts.markHint'))}</span></div>
        <div class="groups-legend">
          <span class="groups-legend-item"><span class="groups-legend-dot known-dot"></span>${esc(t('texts.readLegend'))}</span>
          <span class="groups-legend-item"><span class="groups-legend-dot review-dot"></span>${esc(t('stat.review'))}</span>
        </div>
      </div>`;
    host.innerHTML = filtersHTML + sectionTitleHTML + (levels.length ? '' : `<div class="texts-msg">${esc(t('texts.noResults'))}</div>`) + levels.map(lv => {
      const locked = !isAvailable(lv);   // same rule as Groups: free plan = FREE_HSK only
      // Locked levels never render their titles: only the lock placeholder.
      const items  = locked ? [] : sortTexts(visible.filter(x => x.hsk === lv));
      const closed = locked || (!searching && collapsedLevels.has(lv));   // searching opens the sections
      const readN  = countRead(items.map(x => x.id));
      const pct    = items.length ? Math.round(readN / items.length * 100) : 0;
      const lockHTML = locked ? `
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 0">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="color:var(--faint)"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <p style="font-size:.75rem;color:var(--faint);text-align:center;margin:0">${esc(hskLabel(lv))} ${esc(t('msg.availablePro'))}</p>
          </div>` : '';
      return `
      <div class="hsk-group" data-lv="${lv}"${locked ? ' data-locked="1"' : ''}>
        <div class="hsk-group-header" ${locked ? 'style="opacity:.5;pointer-events:none"' : ''}>
          <div class="hsk-group-label">
            <span class="badge hsk-${lv}">${esc(hskLabel(lv))}</span>
            ${locked
              ? `<span style="font-size:.6rem;color:var(--faint);display:flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>${state.supaUser ? 'Pro' : esc(t('badge.signUp'))}</span>`
              : `<span class="count">${readN}/${items.length} ${esc(t('texts.read'))}</span>`}
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="hsk-prog-bar"><div class="hsk-prog-fill hsk-${lv}-fill" style="width:${pct}%"></div></div>
            <svg class="chevron ${closed ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="hsk-full-bar"><div class="hsk-full-bar-fill hsk-${lv}-fill" style="width:${pct}%"></div></div>
        <div class="char-grid-wrap ${closed ? 'collapsed' : ''}">
          <div class="texts-items">${items.map(x => `
            <button class="texts-item${textState.get(x.id) === 'read' ? ' read' : textState.get(x.id) === 'review' ? ' review' : ''}" type="button" data-id="${x.id}">
              <span class="texts-item-title">${esc(x.title)}${noAudioMark(x)}</span>
              <span class="texts-item-meta">${esc(glossTitle(x))}</span>
            </button>`).join('')}
          </div>${lockHTML}
        </div>
      </div>`;
    }).join('');

    const srcGroup = host.querySelector('#textsSrcGroup');
    if (srcGroup) {
      const wrap = srcGroup.querySelector('.char-grid-wrap');
      const chev = srcGroup.querySelector('.chevron');
      srcGroup.querySelector('.hsk-group-header').onclick = () => {
        sourcesCollapsed = !sourcesCollapsed;
        animateGridWrap(wrap, !sourcesCollapsed);
        chev.classList.toggle('open', !sourcesCollapsed);
      };
      srcGroup.querySelectorAll('.source-tile').forEach(b => {
        b.onclick = () => {
          activeSource = activeSource === b.dataset.src ? null : b.dataset.src;
          sourcesCollapsed = false;   // keep the grid open, like Radicals / Components
          renderTexts();
          if (navigator.vibrate) navigator.vibrate(30);
        };
      });
    }
    host.querySelectorAll('.hsk-group[data-lv]').forEach(g => {
      if (g.dataset.locked) return;
      const lv   = Number(g.dataset.lv);
      const wrap = g.querySelector('.char-grid-wrap');
      const chev = g.querySelector('.chevron');
      g.querySelector('.hsk-group-header').onclick = () => {
        if (wrap.classList.contains('collapsed')) {
          collapsedLevels.delete(lv);
          animateGridWrap(wrap, true);
          chev.classList.add('open');
        } else {
          collapsedLevels.add(lv);
          animateGridWrap(wrap, false);
          chev.classList.remove('open');
        }
      };
    });
    host.querySelectorAll('.texts-item').forEach(b => {
      const id = Number(b.dataset.id);
      // Long-press (450ms, like the Groups tiles) cycles not marked → read → review in place;
      // a normal tap opens the text. The click that follows a long-press is eaten.
      let timer = null, longPressed = false, sx = 0, sy = 0;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      b.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        longPressed = false; sx = e.clientX; sy = e.clientY;
        cancel();
        timer = setTimeout(() => {
          timer = null;
          longPressed = true;
          toggleRead(id);
          paintListItem(b, id);
          if (navigator.vibrate) navigator.vibrate(30);
        }, 450);
      });
      b.addEventListener('pointermove', e => {
        if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel();
      });
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointercancel', cancel);
      b.addEventListener('pointerleave', cancel);
      b.addEventListener('contextmenu', e => e.preventDefault());
      b.onclick = () => {
        if (longPressed) { longPressed = false; return; }
        openId = id; scroll.scrollTop = 0; renderTexts();
      };
    });
    return;
  }

  title.textContent = text.title;
  const gloss = glossTitle(text);   // title_es / title_en for the app language
  sub.textContent   = gloss;
  sub.style.display = gloss ? '' : 'none';
  if (!bodyCache.has(text.id)) {
    host.className = 'texts-list';
    if (bodyState.get(text.id) === 'error') {
      host.innerHTML = `<div class="texts-msg">${esc(t('texts.error'))}</div>`;
      host.onclick = () => { bodyState.delete(text.id); renderTexts(); };
    } else {
      host.innerHTML = `<div class="texts-msg">${esc(t('texts.loading'))}</div>`;
      host.onclick = null;
      loadTextBody(text.id);
    }
    return;
  }
  const doc = bodyCache.get(text.id);
  const trFull = translationOf(doc);
  if (pagerFor !== text.id) { pagerFor = text.id; trPage = false; zhScroll = 0; }   // new text opens on the Chinese page
  host.className = 'texts-reader' + (hlOn ? '' : ' tx-off') + (pyOn ? ' tx-py' : '') + (stOn ? ' tx-st' : '');
  const zhHTML = paragraphsOf(doc.zh).map(paragraphHTML).join('')
    + `<button class="texts-done" type="button"></button>`;

  if (trFull) {
    // Two pages side by side: the full translation sits to the RIGHT of the
    // Chinese text, so swiping left slides it in (and swiping right goes back).
    const trHTML = paragraphsOf(trFull)
      .map(p => `<p>${esc(p.split(SEP).map(s => s.trim()).filter(Boolean).join(' '))}</p>`).join('');
    host.innerHTML = `
      <div class="tx-pager">
        <div class="tx-track">
          <div class="tx-page tx-page-zh" lang="zh"><div class="texts-tr" id="textsTr" aria-live="polite" lang="${state.lang === 'es' && doc.es ? 'es' : 'en'}"></div>${zhHTML}</div>
          <div class="tx-page tx-page-tr" lang="${state.lang === 'es' && doc.es ? 'es' : 'en'}">${trHTML}</div>
        </div>
      </div>`;
  } else {
    host.innerHTML = zhHTML;
  }
  paintDoneBtn(host.querySelector('.texts-done'), text.id);

  // Translation panel above the text: only when the passage has a translation.
  // It shows a hint until a sentence is long-pressed (see paintTr / hideTr).
  if (trFull) {
    trAvailable = true;
    wireSentencePress(host, doc);
    wireOutsideTap();
    wirePager(host.querySelector('.tx-pager'));
  }
  wireSwipeBack(host);   // only acts when there's no pager (no translation)

  host.onclick = e => {
    if (suppressTap) { suppressTap = false; return; }
    if (e.target.closest('.texts-done')) return toggleRead(text.id, host.querySelector('.texts-done'));
    onWordTap(e);
  };
}

export function toggleTextHighlight() {
  hlOn = !hlOn;
  try { localStorage.setItem('shuazi-text-hl', hlOn ? '1' : '0'); } catch (e) {}
  const host = document.getElementById('texts-content');
  host?.classList.toggle('tx-off', !hlOn);
  const btn = document.getElementById('textsHlBtn');
  btn?.classList.toggle('active', hlOn);
  btn?.setAttribute('aria-pressed', String(hlOn));
}

export function toggleTextPinyin() {
  pyOn = !pyOn;
  try { localStorage.setItem('shuazi-text-py', pyOn ? '1' : '0'); } catch (e) {}
  document.getElementById('texts-content')?.classList.toggle('tx-py', pyOn);
  syncPyBtn();
}

export function toggleTextStatus() {
  stOn = !stOn;
  try { localStorage.setItem('shuazi-text-st', stOn ? '1' : '0'); } catch (e) {}
  document.getElementById('texts-content')?.classList.toggle('tx-st', stOn);
  const btn = document.getElementById('textsStBtn');
  btn?.classList.toggle('active', stOn);
  btn?.setAttribute('aria-pressed', String(stOn));
}

/* ── Listen: reads the open passage aloud, one sentence at a time ──
   Sentences (not the whole passage) go to TTS so requests stay short and cache
   well. A run token lets a tap on the button, closing the text or leaving the
   tab cancel the queue. */
// Google Mandarin voices (Wavenet = best quality, for the main cast; Standard
// for secondary roles). `pitch` only matters for the Web Speech fallback.
const V = {
  WA: { name: 'cmn-CN-Wavenet-A',  pitch: 1.2  },   // female
  WB: { name: 'cmn-CN-Wavenet-B',  pitch: 0.8  },   // male
  WC: { name: 'cmn-CN-Wavenet-C',  pitch: 0.7  },   // male
  WD: { name: 'cmn-CN-Wavenet-D',  pitch: 1.1  },   // female
  SA: { name: 'cmn-CN-Standard-A', pitch: 1.3  },   // female
  SB: { name: 'cmn-CN-Standard-B', pitch: 0.9  },   // male
  SC: { name: 'cmn-CN-Standard-C', pitch: 0.6  },   // male
  SD: { name: 'cmn-CN-Standard-D', pitch: 1.0  },   // female
};
// Fixed voice per character, so each one sounds the same in every text. Picked
// so that no two characters sharing a dialogue get the same voice. Only these
// labels count as speakers: any other "xxx：" (recipe headings, a letter's
// salutation, narration) is read aloud as normal text.
const SPEAKER_VOICES = {
  '玛丽': V.WA, '张红': V.WD, '大卫': V.WB, '李军': V.WC,   // main cast
  '中村': V.SB,
  '刘老师': V.SA, '老师': V.SA, '王老师': V.SD,
  '安娜': V.SD, '妈妈': V.SA, '售货员': V.SD,
  '警察': V.SC, '画家': V.SC, '工作人员': V.SC, '工人': V.SB,
  '学生': V.SC, '学生A': V.SD, '学生B': V.SC, '同学': V.SC,
};
// Reading speed for passages, synthesized directly by the TTS (the app default
// elsewhere is 0.9).
// NOTE: LISTEN_RATE, SPEAKER_VOICES and the line building in startListen() are
// mirrored in scripts/build_text_audio.py, which pre-generates each text's
// audio. Change them together (and re-run the script).
const LISTEN_RATE = 0.75;

// Loads a text's audio manifest (texts.audio_url, built by the script) once:
// Map "voice|sentence" → public clip URL. null when there is none or it fails.
async function loadClipManifest(doc, id) {
  // The text was opened before its audio existed: look again (at most every 20 s), so
  // the audio is used as soon as it is ready without reloading the app.
  if (doc && !doc.audioUrl && !(doc.audioCheckedAt > Date.now() - 20000)) {
    doc.audioCheckedAt = Date.now();
    try {
      const { data } = await supa.from('texts').select('audio_url').eq('id', id).single();
      if (data?.audio_url) doc.audioUrl = data.audio_url;
    } catch (e) { /* keep using the live voice */ }
  }
  if (!doc?.audioUrl) return null;
  if (doc.clips !== undefined) return doc.clips;
  try {
    const res = await fetch(doc.audioUrl);
    if (!res.ok) throw new Error('manifest ' + res.status);
    const m = await res.json();
    doc.clips = new Map((m.lines || []).map(l => [`${l.voice}|${l.text}`, ttsPublicUrl(l.path)]));
    // Speakers outside the fixed cast (new names): { name: voice name }, chosen when
    // the audio was generated (see supabase/functions/text-audio.js).
    doc.speakers = m.speakers && typeof m.speakers === 'object' ? m.speakers : {};
  } catch (e) {
    console.warn('text audio manifest failed, using live TTS:', e);
    doc.clips = null;
    doc.speakers = {};
  }
  return doc.clips;
}

// Voice entry (name + pitch) for a voice name stored in a manifest.
const voiceByName = name => Object.values(V).find(v => v.name === name) || (name ? { name, pitch: 1 } : null);
let listenRun = 0;
let listening = false;      // a reading session is active (playing or paused)
let paused = false;
let curLine = null;         // { mode: 'pending'|'audio'|'speech', audio, interrupted }
let resumeWait = null;      // resolves the queue's wait while paused

// Toggles the bottom bar between the tabs and the reader's play button.
export function setReaderMode(on) {
  document.body.classList.toggle('reader-open', on);
  const btn = document.getElementById('txPlayBtn');
  if (btn) btn.tabIndex = on ? 0 : -1;
  document.querySelectorAll('.tabbar .tab').forEach(t => { t.tabIndex = on ? -1 : 0; });
}

function syncListenBtn() {
  const btn = document.getElementById('txPlayBtn');
  if (!btn) return;
  const playing = listening && !paused;
  btn.classList.toggle('active', playing);   // shows the pause icon
  btn.setAttribute('aria-pressed', String(playing));
  btn.setAttribute('aria-label', t(playing ? 'texts.pause' : paused ? 'texts.resume' : 'texts.listen'));
}

export function stopTextAudio() {
  listenRun++;
  if (stopTick) { stopTick(); stopTick = null; }
  const wasActive = listening;
  listening = false; paused = false;
  if (curLine?.audio) curLine.audio.pause();
  curLine = null;
  if (resumeWait) { resumeWait(); resumeWait = null; }
  if (wasActive) { stopSpeaking(); restoreTr(); }
  syncListenBtn();
}

function pauseTextAudio() {
  paused = true;
  const c = curLine;
  if (c?.mode === 'audio') c.audio.pause();          // freezes in place; highlight stays
  else if (c?.mode === 'speech') { c.interrupted = true; stopSpeaking(); }   // replays this sentence on resume
  // 'pending' (cloud audio still loading): it is paused as soon as it starts.
  syncListenBtn();
}

function resumeTextAudio() {
  paused = false;
  const c = curLine;
  if (c?.mode === 'audio') c.audio.play().catch(() => {});
  if (resumeWait) { resumeWait(); resumeWait = null; }
  syncListenBtn();
}

// One <audio> element for the whole reading session, unlocked by the ▶ tap so
// iOS lets every following sentence play on it (a new element per sentence,
// created outside the tap, can be blocked).
let readerAudio = null;
const getReaderAudio = () => (readerAudio ||= Object.assign(new Audio(), { preload: 'auto' }));

export function toggleTextListen() {
  if (listening) return paused ? resumeTextAudio() : pauseTextAudio();
  unlockAudio(getReaderAudio());   // must run synchronously inside the tap
  // Start from the selected sentence (long-press), or from the top.
  const sel = document.querySelector('#texts-content .tx-s.sel');
  const pEl = sel?.closest('p');
  return startListen(pEl ? { pi: Number(pEl.dataset.p), si: Number(sel.dataset.s) } : null);
}

// A sentence was selected (long-press) while reading: jump there and keep
// playing. While paused, the session ends so the next ▶ starts from it.
function listenFromSelection(pi, si) {
  if (!listening) return;
  if (paused) { stopTextAudio(); return; }
  stopTextAudio();
  startListen({ pi, si });
}

async function startListen(from) {
  const doc = openId != null ? bodyCache.get(openId) : null;
  if (!doc) return;
  const run = ++listenRun;
  listening = true;
  syncListenBtn();
  // The manifest comes first: besides the clips it carries the voices of speakers
  // that are not in the fixed cast, which decide how the lines are built below.
  const clips = await loadClipManifest(doc, openId);
  if (run !== listenRun) return;
  const extraSpeakers = doc.speakers || {};
  const speakerVoice = label => SPEAKER_VOICES[label] || voiceByName(extraSpeakers[label]);
  // One entry per sentence: the text to speak, where it sits in the DOM, and a
  // timeline of its words (start = share of the sentence's speaking time).
  const lines = [];
  let voice = null;           // voice of the current speaker (kept across unlabeled lines)
  paragraphsOf(doc.zh).forEach((p, pi) => sentencesOf(tokenize(p)).forEach((s, si) => {
    // Dialogue: "玛丽：…" is not read aloud; the label picks the voice instead.
    // A leading stage direction "（问机场工作人员）" is skipped too.
    let skip = 0;
    if (si === 0) {
      const skipParen = () => {
        if (!/^[（(]$/.test(s[skip]?.text || '')) return;
        const close = s.findIndex((x, i) => i > skip && /^[）)]$/.test(x.text));
        if (close > 0) skip = close + 1;
      };
      skipParen();
      const colon = s.findIndex((x, i) => i >= skip && /^[：:]$/.test(x.text));
      const label = colon > skip ? s.slice(skip, colon).map(x => x.text).join('').trim() : '';
      // A speaker line needs something said after the colon: a lone "刘老师："
      // heading a letter is the salutation, so it is read.
      const saysSomething = colon >= 0 && s.slice(colon + 1).some(x => HAN.test(x.text));
      if (label && speakerVoice(label) && saysSomething) {
        voice = speakerVoice(label);
        skip = colon + 1;
      }
    }
    const spoken = s.slice(skip);
    const line = spoken.map(x => x.text).join('').replace(/\s+/g, '').trim();
    if (!/[\u3400-\u9fff]/.test(line)) return;
    // Hanzi count 1 each; punctuation is a short pause (0.6). Dictionary words
    // (.tx-w) and Han runs outside `words` (.tx-u) are the highlight units;
    // `wi` is the unit's index within the whole sentence (skipped ones included).
    const isUnit = x => x.word || x.han;
    let total = 0, wi = 0;
    s.slice(0, skip).forEach(x => { if (isUnit(x)) wi++; });
    const units = [];
    for (const tok of spoken) {
      const w = isUnit(tok) ? [...tok.text].length : 0.6;
      if (isUnit(tok)) units.push({ start: total, wi: wi++ });
      total += w;
    }
    units.forEach(u => { u.start /= total; });
    lines.push({ line, pi, si, units, chars: total, voice });
  }));
  if (!lines.length) { listening = false; syncListenBtn(); return; }
  // Pre-generated audio (texts.audio_url → manifest, loaded above): clips are played
  // straight from Storage. Sentences missing from it fall back to the TTS API.
  const clipFor = L => clips?.get(`${L.voice?.name || DEFAULT_TTS_VOICE}|${L.line}`);
  // Voices were assigned over the whole text above, so starting midway keeps
  // every character on the same voice.
  let start = from ? lines.findIndex(L => L.pi > from.pi || (L.pi === from.pi && L.si >= from.si)) : 0;
  if (start < 0) start = 0;
  for (let i = start; i < lines.length;) {
    if (run !== listenRun) return;
    // Paused between sentences: wait here until resumed (or stopped).
    if (paused) {
      await new Promise(r => { resumeWait = r; });
      continue;
    }
    const L = lines[i];
    const line = curLine = { mode: 'pending', audio: null, interrupted: false };
    const speakOpts = l => ({ rate: LISTEN_RATE, clipUrl: clipFor(l), audioEl: getReaderAudio(),
      ...(l.voice && { voice: l.voice.name, pitch: l.voice.pitch }) });
    await new Promise(resolve => {
      let started = false, audio = null, raf = 0, t0 = 0, shown = -1, words = [];
      let finished = false, wd = 0;
      const host = document.getElementById('texts-content');
      const pick = () => [...(host?.querySelectorAll(`p[data-p="${L.pi}"] .tx-s[data-s="${L.si}"] :is(.tx-w, .tx-u)`) || [])];
      const sentEl = () => host?.querySelector(`p[data-p="${L.pi}"] .tx-s[data-s="${L.si}"]`);
      let cleanupPlaying = null;   // removes the 'playing' listener from the shared <audio>
      const clear = () => { cancelAnimationFrame(raf); cleanupPlaying?.(); cleanupPlaying = null; setPlaying(null); setReadingSentence(null); };
      stopTick = clear;
      const tick = () => {
        if (run !== listenRun) return;
        if (!words.length || !words[0].isConnected) { words = pick(); shown = -1; }   // list re-rendered under us
        if (!readingSentEl?.isConnected) setReadingSentence(sentEl());
        // Prefer real audio progress; without a usable duration, estimate ~0.27s/char.
        const dur = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : L.chars * 0.27 * (0.9 / LISTEN_RATE);
        const cur = audio ? audio.currentTime : (performance.now() - t0) / 1000;
        const p = Math.min(0.999, Math.max(0, cur / dur));
        let idx = 0;
        for (let i = 0; i < L.units.length; i++) if (L.units[i].start <= p) idx = i;
        const el = words[L.units[idx]?.wi];
        if (idx !== shown && el) {
          shown = idx;
          setPlaying(el);
        }
        raf = requestAnimationFrame(tick);
      };
      const finish = () => {
        if (finished) return;
        finished = true; clearInterval(wd); clear(); resolve();
      };
      // Watchdog: a sentence that stops making progress (clip download hangs,
      // audio stalls, or the fallback voice never reports its end) is skipped
      // instead of blocking the whole reading. Pauses don't count.
      let lastMove = performance.now(), lastTime = -1;
      wd = setInterval(() => {
        // Stale (stopped / jumped elsewhere): just release this await; the UI
        // already belongs to the new reading, so don't clear() it.
        if (run !== listenRun) { finished = true; clearInterval(wd); cancelAnimationFrame(raf); cleanupPlaying?.(); cleanupPlaying = null; return resolve(); }
        const now = performance.now();
        if (paused) { lastMove = now; return; }
        if (line.mode === 'audio' && audio && audio.currentTime !== lastTime) { lastTime = audio.currentTime; lastMove = now; }
        const limit = line.mode === 'pending' ? 15000                        // loading the clip
                    : line.mode === 'speech'  ? Math.max(8000, L.chars * 600) // no progress events
                    : 8000;                                                   // audio not advancing
        if (now - lastMove > limit) {
          console.warn('texts: sentence stuck, skipping:', L.line);
          stopSpeaking();   // also invalidates a clip still loading
          finish();
        }
      }, 1000);
      // Highlighting (word colour, gray sentence, translation box) begins only when the
      // voice really starts: speak() reports "started" as soon as the sentence is
      // requested, i.e. while the clip is still downloading, so lighting up then would
      // colour the first words before any sound.
      let lit = false;
      const beginHighlight = () => {
        if (lit || finished || run !== listenRun || paused) return;
        lit = true;
        t0 = performance.now();   // reference for the estimate used only by the Web Speech fallback
        words = pick();
        raf = requestAnimationFrame(tick);
        paintSentenceTr(L.pi, L.si);   // the box follows the sentence being read
      };
      const onPlaying = () => beginHighlight();
      speak(L.line, on => {
        if (on) {
          started = true;   // lets the end of this sentence be honoured below
          // Web Speech fallback: this second "on" is the voice really starting.
          if (line.mode === 'speech') beginHighlight();
        }
        // Ignore the end of a stale sentence (the watchdog releases it).
        else if (started && run === listenRun) finish();
      }, a => {
        audio = a;
        lastMove = performance.now();   // switched from loading to playing
        if (a) {
          line.mode = 'audio'; line.audio = a;
          // The sound has begun: light up the words. (After a pause the first 'playing'
          // fires on resume, since beginHighlight does nothing while paused.)
          a.addEventListener('playing', onPlaying);
          cleanupPlaying = () => a.removeEventListener('playing', onPlaying);
          // Paused while it was still loading: hold it as soon as play() kicks in.
          a.addEventListener('play', () => { if (paused && run === listenRun) a.pause(); }, { once: true });
          // Load the next sentence while this one plays, so there's no gap.
          const next = lines[i + 1];
          if (next) prefetchTts(next.line, speakOpts(next));
        } else {
          line.mode = 'speech';
          // Web Speech fallback starting while paused: cut it right away.
          if (paused) Promise.resolve().then(() => { line.interrupted = true; stopSpeaking(); });
        }
      }, speakOpts(L));
    });
    if (curLine === line) curLine = null;
    if (!line.interrupted) i++;   // an interrupted sentence is replayed after resume
  }
  if (run === listenRun) { listening = false; paused = false; syncListenBtn(); restoreTr(); }
}

// The sentence being read gets a gray background (same as a selected one).
let readingSentEl = null;
function setReadingSentence(el) {
  if (readingSentEl && readingSentEl !== el) readingSentEl.classList.remove('tx-reading');
  readingSentEl = el;
  el?.classList.add('tx-reading');
}

// Only one word is lit at a time; bring it into view if it scrolled away.
let playingEl = null, stopTick = null;
function setPlaying(el) {
  if (playingEl && playingEl !== el) playingEl.classList.remove('tx-playing');
  playingEl = el;
  if (!el) return;
  el.classList.add('tx-playing');
  const sc = document.getElementById('texts-scroll');
  if (sc) {
    const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (r.top < s.top + 40 || r.bottom > s.bottom - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// Admin: permanently deletes the open text from the database. Its "read" marks go
// with it (text_progress.text_id is `on delete cascade`). Its audio manifest is
// removed too; the sentence clips are left alone because they are shared by content
// (another text can use the same sentence and voice).
async function deleteOpenText() {
  const row = TEXTS.find(x => x.id === openId);
  if (!row || !state.isAdmin) return;
  if (!window.confirm(`${t('texts.deleteConfirm')}\n\n${row.title}`)) return;
  const btn = document.getElementById('textsDelBtn');
  if (btn) btn.disabled = true;
  try {
    await window._supabaseReady;
    // RLS makes an unauthorised delete succeed with 0 rows, so ask for the rows back.
    const { data, error } = await supa.from('texts').delete().eq('id', row.id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('0 rows deleted (missing delete policy?)');
    // Best effort: a leftover manifest is harmless (nothing points to it any more).
    supa.storage.from('tts').remove([`texts/${row.id}.json`]).catch(() => {});
    TEXTS = TEXTS.filter(x => x.id !== row.id);
    bodyCache.delete(row.id);
    textState.delete(row.id);
    saveReadLocal();
    closeText();
  } catch (e) {
    console.error('text delete failed:', e);
    window.alert(`${t('texts.deleteError')}\n${e.message || ''}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function closeText() {
  stopTextAudio();
  openId = null;
  renderTexts();
}

// Called once the words table has finished loading, so an already-open reader
// picks up its tokenization without the user having to leave and come back.
// A word's study status changed (e.g. from its modal): repaint every occurrence
// in the open text right away, in place, so scroll position, the pager and any
// open translation are untouched.
export function syncTextWordStatus(word) {
  document.querySelectorAll('#texts-content .tx-w').forEach(el => {
    if (el.dataset.w !== word) return;
    el.classList.toggle('tx-known', state.known.has(word));
    el.classList.toggle('tx-review', !state.known.has(word) && state.unknown.has(word));
  });
}

export function refreshTexts() {
  if (document.getElementById('screen-texts')?.classList.contains('active')) renderTexts();
}
