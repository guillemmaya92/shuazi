import { t } from './i18n.js';
import { state } from './state.js';
import { hskLabel, supa } from './config.js';
import { isAvailable } from './cards.js';
import { speak, stopSpeaking } from './translator.js';
import { openWordModal, animateGridWrap, EYE_SVG, EYE_OFF_SVG } from './ui.js';

/* ── TEXTS: graded reading passages ──
   Loaded from the Supabase `texts` table. The list only fetches light columns;
   a passage's `text` is fetched when it is opened. `text` is pre-segmented with
   "|" between words and a line break between paragraphs; it is matched against
   the `words` table and tapping a word opens its detail panel. */
let TEXTS = [];                 // list rows: id, title, title_en, title_es, hsk, position
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
      .select('id, title, title_en, title_es, hsk, position')
      .order('hsk').order('position');
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
    const { data, error } = await supa.from('texts').select('text, text_en, text_es').eq('id', id).single();
    if (error) throw error;
    bodyCache.set(id, { zh: data.text || '', en: data.text_en || '', es: data.text_es || '' });
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
   Ids of the texts the user marked as read. Kept in localStorage (works signed
   out) and mirrored to `text_progress` when signed in. */
const READ_KEY = 'shuazi-texts-read';
const readIds = new Set();
try { JSON.parse(localStorage.getItem(READ_KEY) || '[]').forEach(id => readIds.add(Number(id))); } catch (e) {}
let readSyncedFor = null;   // user id whose server rows have been merged in

function saveReadLocal() {
  try { localStorage.setItem(READ_KEY, JSON.stringify([...readIds])); } catch (e) {}
}

// Once per signed-in user: merge the server's rows into the local set and push
// any local-only marks up, then repaint the list.
async function syncReadFromServer() {
  const uid = state.supaUser?.id;
  if (!uid || readSyncedFor === uid) return;
  readSyncedFor = uid;
  try {
    const { data, error } = await supa.from('text_progress').select('text_id').eq('user_id', uid);
    if (error) throw error;
    const remote = new Set((data || []).map(r => r.text_id));
    const localOnly = [...readIds].filter(id => !remote.has(id));
    remote.forEach(id => readIds.add(id));
    saveReadLocal();
    if (localOnly.length) {
      await supa.from('text_progress').upsert(
        localOnly.map(text_id => ({ user_id: uid, text_id, state: 'read', updated_at: new Date().toISOString() })),
        { onConflict: 'user_id,text_id' });
    }
    refreshTexts();
  } catch (e) {
    console.error('text progress sync failed:', e);
    readSyncedFor = null;
  }
}

function paintDoneBtn(btn, id) {
  if (!btn) return;
  const done = readIds.has(id);
  btn.classList.toggle('active', done);
  btn.setAttribute('aria-pressed', String(done));
  btn.innerHTML = (done
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
    : '') + `<span>${esc(t(done ? 'texts.markedRead' : 'texts.markRead'))}</span>`;
}

async function toggleRead(id, btn) {
  const done = !readIds.has(id);
  if (done) readIds.add(id); else readIds.delete(id);
  saveReadLocal();
  paintDoneBtn(btn, id);
  const uid = state.supaUser?.id;
  if (!uid) return;
  try {
    const q = done
      ? supa.from('text_progress').upsert({ user_id: uid, text_id: id, state: 'read', updated_at: new Date().toISOString() }, { onConflict: 'user_id,text_id' })
      : supa.from('text_progress').delete().eq('user_id', uid).eq('text_id', id);
    const { error } = await q;
    if (error) throw error;
  } catch (e) {
    console.error('text progress save failed:', e);
  }
}

// After a long-press toggle in the list: recolor the item and refresh its
// level's "n/m read" count and both progress bars without re-rendering.
function paintListItem(btn, id) {
  btn.classList.toggle('read', readIds.has(id));
  const group = btn.closest('.hsk-group');
  if (!group) return;
  const ids   = [...group.querySelectorAll('.texts-item')].map(el => Number(el.dataset.id));
  const readN = ids.filter(x => readIds.has(x)).length;
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
    const levels = [...new Set(TEXTS.map(x => x.hsk))].sort((a, b) => a - b);
    // Same collapsible HSK sections as the Groups screen (shared classes + animation).
    const sectionTitleHTML = `
      <div class="groups-section-title">
        <div class="groups-section-titletext">${esc(t('texts.sectionTitle'))}<span class="groups-section-sub">${esc(t('texts.markHint'))}</span></div>
        <div class="groups-legend">
          <span class="groups-legend-item"><span class="groups-legend-dot known-dot"></span>${esc(t('texts.readLegend'))}</span>
        </div>
      </div>`;
    host.innerHTML = sectionTitleHTML + levels.map(lv => {
      const locked = !isAvailable(lv);   // same rule as Groups: free plan = FREE_HSK only
      // Locked levels never render their titles: only the lock placeholder.
      const items  = locked ? [] : TEXTS.filter(x => x.hsk === lv);
      const closed = locked || collapsedLevels.has(lv);
      const readN  = items.filter(x => readIds.has(x.id)).length;
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
            <button class="texts-item${readIds.has(x.id) ? ' read' : ''}" type="button" data-id="${x.id}">
              <span class="texts-item-title">${esc(x.title)}</span>
              <span class="texts-item-meta">${esc(glossTitle(x))}</span>
            </button>`).join('')}
          </div>${lockHTML}
        </div>
      </div>`;
    }).join('');

    host.querySelectorAll('.hsk-group').forEach(g => {
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
      // Long-press (450ms, like the Groups tiles) toggles read/unread in place;
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
const LISTEN_RATE = 0.75;
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

export function toggleTextListen() {
  if (listening) return paused ? resumeTextAudio() : pauseTextAudio();
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
      if (label && SPEAKER_VOICES[label] && saysSomething) {
        voice = SPEAKER_VOICES[label];
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
  if (!lines.length) return;
  // Voices were assigned over the whole text above, so starting midway keeps
  // every character on the same voice.
  let start = from ? lines.findIndex(L => L.pi > from.pi || (L.pi === from.pi && L.si >= from.si)) : 0;
  if (start < 0) start = 0;
  const run = ++listenRun;
  listening = true;
  syncListenBtn();
  for (let i = start; i < lines.length;) {
    if (run !== listenRun) return;
    // Paused between sentences: wait here until resumed (or stopped).
    if (paused) {
      await new Promise(r => { resumeWait = r; });
      continue;
    }
    const L = lines[i];
    const line = curLine = { mode: 'pending', audio: null, interrupted: false };
    await new Promise(resolve => {
      let started = false, audio = null, raf = 0, t0 = 0, shown = -1, words = [];
      const host = document.getElementById('texts-content');
      const pick = () => [...(host?.querySelectorAll(`p[data-p="${L.pi}"] .tx-s[data-s="${L.si}"] :is(.tx-w, .tx-u)`) || [])];
      const sentEl = () => host?.querySelector(`p[data-p="${L.pi}"] .tx-s[data-s="${L.si}"]`);
      const clear = () => { cancelAnimationFrame(raf); setPlaying(null); setReadingSentence(null); };
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
      const finish = () => { clear(); resolve(); };
      speak(L.line, on => {
        if (on) {
          t0 = performance.now();   // (re)start the estimate when the voice really starts
          if (!started) {
            started = true; words = pick(); raf = requestAnimationFrame(tick);
            paintSentenceTr(L.pi, L.si);   // the box follows the sentence being read
          }
        }
        else if (started) finish();
      }, a => {
        audio = a;
        if (a) {
          line.mode = 'audio'; line.audio = a;
          // Paused while it was still loading: hold it as soon as play() kicks in.
          a.addEventListener('play', () => { if (paused && run === listenRun) a.pause(); }, { once: true });
        } else {
          line.mode = 'speech';
          // Web Speech fallback starting while paused: cut it right away.
          if (paused) Promise.resolve().then(() => { line.interrupted = true; stopSpeaking(); });
        }
      }, { rate: LISTEN_RATE, ...(L.voice && { voice: L.voice.name, pitch: L.voice.pitch }) });
      // Safety net: if playback never reports back, don't hang the queue.
      setTimeout(() => { if (!started) finish(); }, 8000);
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

export function closeText() {
  stopTextAudio();
  openId = null;
  renderTexts();
}

// Called once the words table has finished loading, so an already-open reader
// picks up its tokenization without the user having to leave and come back.
export function refreshTexts() {
  if (document.getElementById('screen-texts')?.classList.contains('active')) renderTexts();
}
