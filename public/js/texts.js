import { t } from './i18n.js';
import { state } from './state.js';
import { hskLabel, supa } from './config.js';
import { openWordModal, animateGridWrap, EYE_SVG, EYE_OFF_SVG } from './ui.js';

/* ── TEXTS: graded reading passages ──
   Loaded from the Supabase `texts` table. The list only fetches light columns;
   a passage's `text` is fetched when it is opened. `text` is pre-segmented with
   "|" between words and a blank line between paragraphs; it is matched against
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

const paragraphsOf = s => String(s).split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);

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
  const toks = tokens.flatMap(t => t.word ? [t] : [...t.text].map(c => ({ text: c })));
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
  box.style.display = '';   // the box only exists while a sentence is selected
}

function hideTr() {
  const box = document.getElementById('textsTr');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

/* ── Full-translation page ──
   Swipe left on the reader to slide in the whole translation (it sits to the
   right of the Chinese); swipe right to return. Horizontal drags only (touch-action: pan-y keeps
   vertical scrolling native). */
let trPage   = false;   // true while the translation page is shown
let pagerFor = null;    // text id the pager state belongs to

function setPage(pager, toTr, animate = true) {
  trPage = toTr;
  const track = pager.querySelector('.tx-track');
  const pages = pager.querySelectorAll('.tx-page');
  pages.forEach(p => p.classList.remove('off'));               // both laid out while moving
  track.classList.toggle('dragging', !animate);
  track.style.transform = toTr ? 'translateX(-50%)' : 'translateX(0)';
  const settle = () => {
    // Collapse the hidden page so the scroll height follows the visible one.
    pager.querySelector(toTr ? '.tx-page-zh' : '.tx-page-tr').classList.add('off');
  };
  if (animate) {
    // transitionend can be skipped (interrupted / no movement), so a timeout backs it up.
    let fired = false;
    const once = () => { if (fired) return; fired = true; track.removeEventListener('transitionend', onEnd); if (trPage === toTr) settle(); };
    const onEnd = e => { if (e.target === track) once(); };
    track.addEventListener('transitionend', onEnd);
    setTimeout(once, 400);
  } else settle();
  if (toTr) clearSentence();   // the box never shows over the full translation
}

function wirePager(pager) {
  if (!pager) return;
  const track = pager.querySelector('.tx-track');
  setPage(pager, trPage, false);
  let id = null, sx = 0, sy = 0, dx = 0, axis = null;
  pager.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; axis = null;
  });
  pager.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!axis) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      axis = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y';
      if (axis === 'x') {
        try { pager.setPointerCapture(id); } catch (err) {}
        pager.querySelectorAll('.tx-page').forEach(p => p.classList.remove('off'));
        track.classList.add('dragging');
      }
    }
    if (axis !== 'x') return;
    // Rubber-band when dragging past either end.
    dx = (trPage ? mx < 0 : mx > 0) ? mx * 0.25 : mx;
    track.style.transform = `translateX(calc(${trPage ? '-50%' : '0%'} + ${dx}px))`;
  });
  const end = e => {
    if (e.pointerId !== id) return;
    id = null;
    if (axis !== 'x') return;
    suppressTap = true;   // the click that ends a drag must not open a word
    const w = pager.offsetWidth || 1;
    const flip = Math.abs(dx) > Math.min(80, w * 0.22);
    const toTr = trPage ? !(flip && dx > 0) : (flip && dx < 0);
    setPage(pager, toTr, true);
  };
  pager.addEventListener('pointerup', end);
  pager.addEventListener('pointercancel', end);
}

// Deselect the sentence and hide the translation box.
function clearSentence() {
  const host = document.getElementById('texts-content');
  host?.querySelectorAll('.tx-s.sel').forEach(x => x.classList.remove('sel'));
  hideTr();
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
  const trBox  = document.getElementById('textsTr');
  if (!host) return;
  // Reset the reader-only handlers; the reader branch re-wires them.
  host.onpointerdown = host.onpointermove = host.onpointerup = host.onpointercancel = host.oncontextmenu = null;
  if (trBox) trBox.style.display = 'none';

  const text = openId != null ? TEXTS.find(x => x.id === openId) : null;
  if (openId != null && !text) openId = null;   // list changed under us
  back.style.display = text ? '' : 'none';
  hlBtn.style.display = text ? '' : 'none';
  pyBtn.style.display = text ? '' : 'none';
  stBtn.style.display = text ? '' : 'none';
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
    host.innerHTML = levels.map(lv => {
      const items  = TEXTS.filter(x => x.hsk === lv);
      const closed = collapsedLevels.has(lv);
      const readN  = items.filter(x => readIds.has(x.id)).length;
      const pct    = items.length ? Math.round(readN / items.length * 100) : 0;
      return `
      <div class="hsk-group" data-lv="${lv}">
        <div class="hsk-group-header">
          <div class="hsk-group-label">
            <span class="badge hsk-${lv}">${esc(hskLabel(lv))}</span>
            <span class="count">${readN}/${items.length} ${esc(t('texts.read'))}</span>
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
          </div>
        </div>
      </div>`;
    }).join('');

    host.querySelectorAll('.hsk-group').forEach(g => {
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
  if (pagerFor !== text.id) { pagerFor = text.id; trPage = false; }   // new text opens on the Chinese page
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
          <div class="tx-page tx-page-zh" lang="zh">${zhHTML}</div>
          <div class="tx-page tx-page-tr" lang="${state.lang === 'es' && doc.es ? 'es' : 'en'}">${trHTML}</div>
        </div>
      </div>`;
  } else {
    host.innerHTML = zhHTML;
  }
  paintDoneBtn(host.querySelector('.texts-done'), text.id);

  // Translation panel above the text: only when the passage has a translation.
  // The box stays hidden until a sentence is long-pressed (see paintTr / hideTr).
  if (trBox && trFull) {
    wireSentencePress(host, doc);
    wireOutsideTap();
    wirePager(host.querySelector('.tx-pager'));
  }

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

export function closeText() {
  openId = null;
  renderTexts();
}

// Called once the words table has finished loading, so an already-open reader
// picks up its tokenization without the user having to leave and come back.
export function refreshTexts() {
  if (document.getElementById('screen-texts')?.classList.contains('active')) renderTexts();
}
