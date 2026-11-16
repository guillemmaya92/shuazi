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
    const { data, error } = await supa.from('texts').select('text').eq('id', id).single();
    if (error) throw error;
    bodyCache.set(id, data.text || '');
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
    return py ? `<ruby>${esc(ch)}<rt>${esc(py)}</rt></ruby>` : esc(ch);
  }).join('');
}

function paragraphHTML(p) {
  return '<p>' + tokenize(p).map(tok =>
    tok.word
      ? `<span class="tx-w tx-h${tok.word.hsk ?? 0}${state.known.has(tok.text) ? ' tx-known' : state.unknown.has(tok.text) ? ' tx-review' : ''}" data-w="${esc(tok.text)}"><ruby><span class="tx-b">${esc(tok.text)}</span><rt>${esc(tok.word.pinyin ?? '')}</rt></ruby></span>`
      : plainHTML(tok.text)
  ).join('') + '</p>';
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
  host.className = 'texts-reader' + (hlOn ? '' : ' tx-off') + (pyOn ? ' tx-py' : '') + (stOn ? ' tx-st' : '');
  host.innerHTML = paragraphsOf(bodyCache.get(text.id)).map(paragraphHTML).join('')
    + `<button class="texts-done" type="button"></button>`;
  paintDoneBtn(host.querySelector('.texts-done'), text.id);
  host.onclick = e => {
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
