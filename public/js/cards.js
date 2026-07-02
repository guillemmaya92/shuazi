import { supa, FREE_HSK, hskLabel } from './config.js';
import { state } from './state.js';
import { localizeRow, t } from './i18n.js';
import { saveState, loadState, saveSettings } from './progress.js';
import { reschedule, isDue } from './srs.js';
import { renderGroups, openWordModal, openModal } from './ui.js';
import { speak } from './translator.js';

// Speaker SVG used by the per-card "listen" button.
const LISTEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7 6.6 8.2H3v7.6h3.6L11 19.3z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.5 6.5a9 9 0 0 1 0 11"/></svg>';

// Wires a card's listen button to play the character's pronunciation. Stops
// pointer/click propagation so it never triggers the card's drag or tap zones.
function attachListen(el, text) {
  const btn = el.querySelector('.listen-btn');
  if (!btn) return;
  btn.addEventListener('pointerdown', e => e.stopPropagation());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    speak(text, on => btn.classList.toggle('playing', on));
  });
}

// Cache in-flight promises so prefetch + on-demand callers share one request
// (and a fast tap awaits the prefetch instead of racing it to an empty result).
const _wordPromises = {};
export function fetchWordsForChar(card) {
  const key = card.char;
  if (state.wordsByChar[key] !== undefined) return Promise.resolve();
  if (_wordPromises[key]) return _wordPromises[key];
  _wordPromises[key] = (async () => {
    const { data } = await supa
      .from('words')
      .select('id, word, pinyin, meaning, meaning_es, hsk, frequency, char_word!inner(id_char)')
      .eq('char_word.id_char', card.id)
      .order('frequency', { ascending: false });
    state.wordsByChar[key] = (data || []).map(w => localizeRow({
      dbId:       w.id,
      id:         w.word,
      pinyin:     w.pinyin,
      meaning:    w.meaning,
      meaning_es: w.meaning_es,
      hsk:        w.hsk,
    }, ['meaning']));
  })();
  return _wordPromises[key];
}

// Lazily fetch the phrases linked to a word (via the word_phrase join table),
// caching by the word's numeric id so each word is only queried once.
const _phrasePromises = {};
export function fetchPhrasesForWord(wordId) {
  if (state.phrasesByWord[wordId] !== undefined) return Promise.resolve();
  if (_phrasePromises[wordId]) return _phrasePromises[wordId];
  _phrasePromises[wordId] = (async () => {
    // 1) ids of phrases linked to this word (filter the join table by id_word)
    const { data: links } = await supa
      .from('word_phrase')
      .select('id_phrase')
      .eq('id_word', wordId);
    const ids = (links || []).map(l => l.id_phrase);
    if (ids.length === 0) {
      state.phrasesByWord[wordId] = [];
      return;
    }
    // 2) fetch those phrases
    const { data } = await supa
      .from('phrases')
      .select('phrase, pinyin, meaning, meaning_es')
      .in('id', ids)
      .order('id', { ascending: true });
    state.phrasesByWord[wordId] = (data || []).map(p => localizeRow({
      phrase:     p.phrase,
      pinyin:     p.pinyin,
      meaning:    p.meaning,
      meaning_es: p.meaning_es,
    }, ['meaning']));
  })();
  return _phrasePromises[wordId];
}

export function normalizePinyin(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
}

export function isAvailable(hsk) {
  return state.userPlan === 'pro' || FREE_HSK.has(hsk);
}

// Apply the status filters + SRS due-gating, then order the deck: due (scheduled)
// items first, soonest-due first, with new/unscheduled items shuffled after.
// Known/Review items that aren't due yet rest out of the deck until their date.
function srsSelect(cards) {
  const now = Date.now();
  const sel = cards.filter(c => {
    if (state.known.has(c.char))   return state.activeStatuses.has('know')   && isDue(state.schedule[c.char], now);
    if (state.unknown.has(c.char)) return state.activeStatuses.has('review') && isDue(state.schedule[c.char], now);
    return state.activeStatuses.has('left');
  });
  const scheduled = sel.filter(c => state.schedule[c.char]);
  const fresh     = sel.filter(c => !state.schedule[c.char]);
  scheduled.sort((a, b) => state.schedule[a.char].due - state.schedule[b.char].due);
  shuffle(fresh);
  return [...scheduled, ...fresh];
}

export function buildDeck(src) {
  const filtered = src.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
  const cards = srsSelect(filtered);
  state.deckInitial = cards.length;   // reset session progress for the new deck
  return cards;
}

export function buildWordDeck() {
  const filtered = state.WORDS
    .filter(w => state.activeHskLevels.has(w.hsk) && isAvailable(w.hsk))
    .map(w => ({ ...w, char: w.word, isWord: true }));
  const cards = srsSelect(filtered);
  state.deckInitial = cards.length;   // reset session progress for the new deck
  return cards;
}

const deckEl  = document.getElementById('deck');
const vRest   = document.getElementById('vRest');
const vKnown  = document.getElementById('vKnown');
const vRepaso = document.getElementById('vRepaso');
const deckProgFill = document.getElementById('deckProgFill');
const deckProgPct  = document.getElementById('deckProgPct');

// Thin progress bar: session progress through the current deck —
// (initial deck size − cards remaining) / initial. Respects every filter
// because it's derived from the actual deck, and resets when the deck rebuilds.
export function updateDeckProgress() {
  if (!deckProgFill) return;
  const init = state.deckInitial || 0;
  const done = Math.max(0, init - state.deck.length);
  const pct  = init ? Math.min(100, Math.round(done / init * 100)) : 0;
  deckProgFill.style.width = pct + '%';
  deckProgPct.textContent  = pct + '%';
}

export function stats() {
  if (state.groupsContent === 'words') {
    const filtered = state.WORDS.filter(w => state.activeHskLevels.has(w.hsk) && isAvailable(w.hsk));
    const knownN   = filtered.filter(w => state.known.has(w.word)).length;
    const reviewN  = filtered.filter(w => state.unknown.has(w.word)).length;
    const leftN    = filtered.length - knownN - reviewN;
    vRest.textContent   = leftN;
    vKnown.textContent  = knownN;
    vRepaso.textContent = reviewN;
    updateDeckProgress();
    const pKnown = document.getElementById('p-known');
    if (pKnown) {
      const knownCov = state.WORDS.filter(w => state.known.has(w.word)).reduce((s, w) => s + (w.frequency ?? 0), 0);
      const pct = Math.min(100, Math.round(knownCov * 100));
      pKnown.textContent = knownN;
      document.getElementById('p-review').textContent = reviewN;
      document.getElementById('p-left').textContent   = leftN;
      document.getElementById('p-pct').textContent    = pct + '%';
      document.getElementById('p-bar').style.width    = pct + '%';
    }
  } else {
    const filtered = state.CHARACTERS.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
    const knownN   = filtered.filter(c => state.known.has(c.char)).length;
    const reviewN  = filtered.filter(c => state.unknown.has(c.char)).length;
    const leftN    = filtered.length - knownN - reviewN;
    vRest.textContent   = leftN;
    vKnown.textContent  = knownN;
    vRepaso.textContent = reviewN;
    updateDeckProgress();
    const pKnown = document.getElementById('p-known');
    if (pKnown) {
      const cov = state.CHARACTERS.filter(c => state.known.has(c.char)).reduce((s, c) => s + (c.frequency ?? 0), 0);
      const pct = Math.min(100, Math.round(cov * 100));
      pKnown.textContent = knownN;
      document.getElementById('p-review').textContent = reviewN;
      document.getElementById('p-left').textContent   = leftN;
      document.getElementById('p-pct').textContent    = pct + '%';
      document.getElementById('p-bar').style.width    = pct + '%';
    }
  }
  saveState();
  renderGroups();
}

const PAGES = 2;

function makeCard(card, isStack) {
  const el = document.createElement('article');
  el.className = 'card ' + (isStack ? 'stack-under' : 'top');
  el.dataset.page = '0';

  const radInfo = state.RADICALS?.find(r => r.radical === card.radical);
  const radicalHTML = card.radical
    ? `<span class="char-chip"><span class="cc-glyph">${card.radical}</span>${radInfo?.pinyin ? `<span class="cc-py">${radInfo.pinyin}</span>` : ''}</span>`
    : '<span class="char-chip-empty">—</span>';

  el.innerHTML = `
    <div class="tint tint-l"></div>
    <div class="tint tint-r"></div>
    <div class="tint tint-u"></div>
    <div class="chip chip-l">Left</div>
    <div class="chip chip-r">Known</div>
    <div class="chip chip-u">Review</div>
    <div class="story-bar">
      <div class="seg active" data-i="0"></div>
      <div class="seg"        data-i="1"></div>
    </div>
    <div class="tap-zones">
      <button class="tz tz-left"   tabindex="-1" aria-label="Mark as left"></button>
      <button class="tz tz-center" tabindex="-1" aria-label="Reveal answer"></button>
      <button class="tz tz-right"  tabindex="-1" aria-label="${t('card.moreInfoAria')}"></button>
    </div>
    <div class="pages" id="pages">
      <div class="page" style="justify-content:space-between;">
        <div class="card-top"><span class="prog"></span></div>
        <div class="hanzi-wrap"><div class="hanzi">${card.char}</div></div>
        <div class="answer-area" id="aa"></div>
        <div class="card-bottom">
          <span class="tap-hint" id="tap-hint">${t('card.tapReveal')}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="hsk-pill hsk-${card.hsk}">${hskLabel(card.hsk)}</span>
          </div>
        </div>
      </div>
      <div class="page info-page" style="padding-top:32px">
        <div class="info-row" style="grid-template-columns:0.82fr 0.82fr 1.18fr 1.18fr">
          <div class="info-cell"><div class="lbl">${t('lbl.hanzi')}</div><button class="card-word-btn" type="button" style="font-family:var(--cjk)">${card.char}</button></div>
          <div class="info-cell"><div class="lbl">${t('lbl.pinyin')}</div><div class="val">${card.pinyin}</div></div>
          <div class="info-cell"><div class="lbl">${t('lbl.radical')}</div><div class="char-chips">${radicalHTML}</div></div>
          <div class="info-cell"><div class="lbl">${t('lbl.level')}</div><div class="val"><span class="hsk-pill hsk-${card.hsk}" style="font-size:.62rem">${hskLabel(card.hsk)}</span></div></div>
          <div class="info-cell full"><div class="lbl">${t('lbl.meaning')}</div><div class="val">${card.meaning}</div></div>
          <div class="info-cell full"><div class="lbl">${t('lbl.compoundWords')}</div><div class="word-phrases-list"></div></div>
        </div>
      </div>
    </div>
    <button class="listen-btn" aria-label="Listen to pronunciation">${LISTEN_SVG}</button>
  `;

  attachListen(el, card.char);

  const pages    = el.querySelector('#pages');
  const segs     = el.querySelectorAll('.seg');
  const tzL      = el.querySelector('.tz-left');
  const tzC      = el.querySelector('.tz-center');
  const tzR      = el.querySelector('.tz-right');
  const aa       = el.querySelector('#aa');
  const wordsList = el.querySelector('.word-phrases-list');

  // The hanzi chip on the info page opens the full character modal. It lives inside
  // .pages (its own stacking context from the slide transform), so it can't paint
  // above the tap-zone overlay — we hit-test the tap against its rect instead.
  const wordBtn = el.querySelector('.card-word-btn');
  function maybeOpenWord(e) {
    if (+el.dataset.page !== 1) return false;
    const r = wordBtn.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      openModal(card);
      return true;
    }
    return false;
  }

  function goPage(n) {
    el.dataset.page = String(n);
    pages.style.transform = `translateX(-${n * 100}%)`;
    segs.forEach((s, i) => s.classList.toggle('active', i === n));
    if (n === 1) fillInfoWords();
  }

  async function fillInfoWords() {
    if (wordsList.dataset.loaded) return;
    await fetchWordsForChar(card);
    wordsList.dataset.loaded = '1';
    // Show the most-used compound words: 2+ characters only, ordered by HSK then
    // frequency desc (the fetch already returns frequency desc, so a stable sort by
    // HSK keeps the most-frequent word first within each level).
    const cardWords = (state.wordsByChar[card.char] || [])
      .filter(w => [...(w.id || '')].length > 1)
      .sort((a, b) => (a.hsk ?? 99) - (b.hsk ?? 99))
      .slice(0, 3);
    wordsList.style.display       = 'flex';
    wordsList.style.flexDirection = 'column';
    wordsList.style.gap           = '6px';
    wordsList.innerHTML = cardWords.length
      ? cardWords.map(w =>
          `<div style="display:flex;flex-direction:column;gap:2px;padding:7px 9px;background:var(--surf2);border:1px solid var(--bdr);border-radius:9px"><span style="font-family:var(--cjk);font-size:.9rem;font-weight:600;color:var(--txt);line-height:1.3">${w.id}</span><span style="font-size:.72rem;color:var(--muted);line-height:1.3">${w.pinyin ?? ''}</span><span style="font-size:.72rem;color:var(--faint);line-height:1.3">${w.meaning ?? ''}</span></div>`
        ).join('')
      : '<span style="color:var(--faint);font-size:.75rem">No words found</span>';
  }

  tzL.addEventListener('click', e => { e.stopPropagation(); if (maybeOpenWord(e)) return; const c = +el.dataset.page; if (c > 0) goPage(c - 1); });
  tzR.addEventListener('click', e => { e.stopPropagation(); const c = +el.dataset.page; if (c < PAGES - 1) goPage(c + 1); });
  tzC.addEventListener('click', async e => {
    e.stopPropagation();
    if (maybeOpenWord(e)) return;
    if (+el.dataset.page !== 0) return;
    const tapHint = el.querySelector('#tap-hint');
    if (el.dataset.answer === '1') {
      el.dataset.answer = '0'; aa.innerHTML = '';
      tapHint.style.visibility = 'visible';
    } else {
      el.dataset.answer = '1';
      tapHint.style.visibility = 'hidden';
      await fetchWordsForChar(card);
      // Same criterion as the info page: most-used compound word (2+ characters),
      // ordered by HSK then frequency desc, so the example isn't just the card char.
      const w = (state.wordsByChar[card.char] || [])
        .filter(x => [...(x.id || '')].length > 1)
        .sort((a, b) => (a.hsk ?? 99) - (b.hsk ?? 99))[0];
      const exHTML = w
        ? `<span style="display:block;color:var(--txt);font-size:.9rem;font-family:var(--cjk);font-weight:600;line-height:1.3">${w.id}</span><span style="display:block;color:var(--muted);font-size:.75rem;font-weight:300;line-height:1.3">${w.pinyin}</span><span style="display:block;color:var(--faint);font-size:.75rem;font-weight:300;line-height:1.3">${w.meaning}</span>`
        : '—';
      aa.innerHTML = `<div class="answer-block">
        <div class="ans-pinyin">${card.pinyin}</div>
        <div class="ans-meaning">${card.meaning}</div>
        <div class="ans-example"><span>${t('card.example')}</span>${exHTML}</div>
        <div class="ans-hint">${t('card.moreInfo')}</div>
      </div>`;
    }
  });

  if (!isStack) attachDrag(el);
  return el;
}

function makeWordCard(card, isStack) {
  const el = document.createElement('article');
  el.className = 'card ' + (isStack ? 'stack-under' : 'top');
  el.dataset.page = '0';

  const wordLen  = [...card.char].length;
  const fontSize = wordLen === 1 ? null : wordLen === 2 ? '100px' : wordLen === 3 ? '76px' : '58px';

  const wordCharsHTML = [...card.char].map(ch => {
    const c = state.CHARACTERS.find(x => x.char === ch);
    return c
      ? `<span class="char-chip"><span class="cc-glyph">${ch}</span>${c.pinyin ? `<span class="cc-py">${c.pinyin}</span>` : ''}</span>`
      : `<span class="char-chip"><span class="cc-glyph">${ch}</span></span>`;
  }).join('');

  const posDesc = state.POS_TAGS?.[card.pos];
  const posHTML = posDesc
    ? `<span class="char-chip"><span class="cc-glyph" style="font-size:.72rem">${posDesc}</span></span>`
    : '<span class="char-chip-empty">—</span>';

  el.innerHTML = `
    <div class="tint tint-l"></div>
    <div class="tint tint-r"></div>
    <div class="tint tint-u"></div>
    <div class="chip chip-l">Left</div>
    <div class="chip chip-r">Known</div>
    <div class="chip chip-u">Review</div>
    <div class="story-bar">
      <div class="seg active" data-i="0"></div>
      <div class="seg"        data-i="1"></div>
    </div>
    <div class="tap-zones">
      <button class="tz tz-left"   tabindex="-1" aria-label="Mark as left"></button>
      <button class="tz tz-center" tabindex="-1" aria-label="Reveal answer"></button>
      <button class="tz tz-right"  tabindex="-1" aria-label="${t('card.moreInfoAria')}"></button>
    </div>
    <div class="pages" id="pages">
      <div class="page" style="justify-content:space-between;">
        <div class="card-top"><span class="prog"></span></div>
        <div class="hanzi-wrap"><div class="hanzi" ${fontSize ? `style="font-size:${fontSize}"` : ''}>${card.char}</div></div>
        <div class="answer-area" id="aa"></div>
        <div class="card-bottom">
          <span class="tap-hint" id="tap-hint">${t('card.tapReveal')}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="hsk-pill hsk-${card.hsk}">${hskLabel(card.hsk)}</span>
          </div>
        </div>
      </div>
      <div class="page info-page" style="padding-top:32px">
        <div class="info-row" style="grid-template-columns:1fr 1fr">
          <div class="info-cell"><div class="lbl">${t('lbl.word')}</div><button class="card-word-btn" type="button" style="font-family:var(--cjk)">${card.char}</button></div>
          <div class="info-cell"><div class="lbl">${t('lbl.level')}</div><div class="val"><span class="hsk-pill hsk-${card.hsk}">${hskLabel(card.hsk)}</span></div></div>
          <div class="info-cell"><div class="lbl">${t('lbl.pinyin')}</div><div class="val">${card.pinyin ?? '—'}</div></div>
          <div class="info-cell"><div class="lbl">${t('lbl.pos')}</div><div class="char-chips">${posHTML}</div></div>
          <div class="info-cell full"><div class="lbl">${t('lbl.meaning')}</div><div class="val">${card.meaning ?? '—'}</div></div>
          <div class="info-cell full"><div class="lbl">${t('lbl.phrases')}</div><div class="word-phrases-list"></div></div>
        </div>
      </div>
    </div>
    <button class="listen-btn" aria-label="Listen to pronunciation">${LISTEN_SVG}</button>
  `;

  attachListen(el, card.char);

  const pages = el.querySelector('#pages');
  const segs  = el.querySelectorAll('.seg');
  const tzL   = el.querySelector('.tz-left');
  const tzC   = el.querySelector('.tz-center');
  const tzR   = el.querySelector('.tz-right');
  const aa    = el.querySelector('#aa');

  // The word glyph on the info page acts as a button to open the full word modal.
  // It lives inside .pages (its own stacking context from the slide transform), so
  // it can never paint above the tap-zone overlay — instead we hit-test the tap
  // against its rect from within the tap-zone handlers below.
  const wordBtn = el.querySelector('.card-word-btn');
  function maybeOpenWord(e) {
    if (+el.dataset.page !== 1) return false;
    const r = wordBtn.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      openWordModal(card);
      return true;
    }
    return false;
  }

  const phrasesEl = el.querySelector('.word-phrases-list');

  function renderPhrases() {
    const cached = state.phrasesByWord[card.id];
    if (cached === undefined) {
      phrasesEl.innerHTML = '<span style="color:var(--faint);font-size:.75rem">Loading…</span>';
      fetchPhrasesForWord(card.id).then(renderPhrases);
      return;
    }
    const top3 = cached.slice(0, 3);
    phrasesEl.style.display       = 'flex';
    phrasesEl.style.flexDirection = 'column';
    phrasesEl.style.gap           = '6px';
    phrasesEl.innerHTML = top3.length
      ? top3.map(p => `<div style="display:flex;flex-direction:column;gap:2px;padding:7px 9px;background:var(--surf2);border:1px solid var(--bdr);border-radius:9px"><span style="font-family:var(--cjk);font-size:.9rem;font-weight:600;color:var(--txt);line-height:1.3">${p.phrase}</span><span style="font-size:.72rem;color:var(--muted);line-height:1.3">${p.pinyin ?? ''}</span><span style="font-size:.72rem;color:var(--faint);line-height:1.3">${p.meaning ?? ''}</span></div>`).join('')
      : '<span style="color:var(--faint);font-size:.75rem">No phrases found</span>';
  }

  function goPage(n) {
    el.dataset.page = String(n);
    pages.style.transform = `translateX(-${n * 100}%)`;
    segs.forEach((s, i) => s.classList.toggle('active', i === n));
    if (n === 1) renderPhrases();
  }

  tzL.addEventListener('click', e => { e.stopPropagation(); if (maybeOpenWord(e)) return; const c = +el.dataset.page; if (c > 0) goPage(c - 1); });
  tzR.addEventListener('click', e => { e.stopPropagation(); const c = +el.dataset.page; if (c < PAGES - 1) goPage(c + 1); });
  tzC.addEventListener('click', async e => {
    e.stopPropagation();
    if (maybeOpenWord(e)) return;
    if (+el.dataset.page !== 0) return;
    const tapHint = el.querySelector('#tap-hint');
    if (el.dataset.answer === '1') {
      el.dataset.answer = '0'; aa.innerHTML = '';
      tapHint.style.visibility = 'visible';
    } else {
      el.dataset.answer = '1';
      tapHint.style.visibility = 'hidden';
      await fetchPhrasesForWord(card.id);
      const phrase = (state.phrasesByWord[card.id] || [])[0];
      const exHTML = phrase
        ? `<span style="display:block;color:var(--txt);font-size:.9rem;font-family:var(--cjk);font-weight:600;line-height:1.3">${phrase.phrase}</span><span style="display:block;color:var(--muted);font-size:.75rem;font-weight:300;line-height:1.3">${phrase.pinyin ?? ''}</span><span style="display:block;color:var(--faint);font-size:.75rem;font-weight:300;line-height:1.3">${phrase.meaning ?? ''}</span>`
        : '—';
      aa.innerHTML = `<div class="answer-block">
        <div class="ans-pinyin">${card.pinyin ?? ''}</div>
        <div class="ans-meaning">${card.meaning ?? ''}</div>
        <div class="ans-example"><span>${t('card.example')}</span>${exHTML}</div>
        <div class="ans-hint">${t('card.moreInfo')}</div>
      </div>`;
    }
  });

  if (!isStack) attachDrag(el);
  return el;
}

export function render() {
  deckEl.innerHTML = ''; stats();
  if (state.deck.length === 0) { showDone(); return; }
  const factory = (c, stack) => c.isWord ? makeWordCard(c, stack) : makeCard(c, stack);
  if (state.deck.length > 1) deckEl.appendChild(factory(state.deck[1], true));
  deckEl.appendChild(factory(state.deck[0], false));
  if (state.deck[0]) state.deck[0].isWord ? fetchPhrasesForWord(state.deck[0].id) : fetchWordsForChar(state.deck[0]);
  if (state.deck[1]) state.deck[1].isWord ? fetchPhrasesForWord(state.deck[1].id) : fetchWordsForChar(state.deck[1]);
}

export function classifyKnown() {
  if (state.deck.length === 0) return;
  const top = deckEl.querySelector('.card.top'); if (!top) return;
  top.classList.add('fly');
  top.style.transform = 'translateX(140%) rotate(16deg)';
  top.style.opacity = '0';
  const card = state.deck.shift();
  state.known.add(card.char); state.unknown.delete(card.char);
  state.schedule[card.char] = reschedule(state.schedule[card.char], 'good');
  saveState();
  setTimeout(render, 210);
}

export function classifyLeft() {
  if (state.deck.length === 0) return;
  const top = deckEl.querySelector('.card.top'); if (!top) return;
  top.classList.add('fly');
  top.style.transform = 'translateX(-140%) rotate(-16deg)';
  top.style.opacity = '0';
  const card = state.deck.shift();
  state.known.delete(card.char); state.unknown.delete(card.char);
  delete state.schedule[card.char];   // "Left" → back to new/unscheduled
  saveState();
  const pos = state.deck.length > 1 ? 1 + Math.floor(Math.random() * state.deck.length) : state.deck.length;
  state.deck.splice(pos, 0, card);
  setTimeout(render, 210);
}

export function classifyReview() {
  if (state.deck.length === 0) return;
  const top = deckEl.querySelector('.card.top'); if (!top) return;
  top.classList.add('fly');
  top.style.transform = `translateY(-140%) rotate(${(Math.random() - .5) * 10}deg)`;
  top.style.opacity = '0';
  const card = state.deck.shift();
  state.unknown.add(card.char); state.known.delete(card.char);
  state.schedule[card.char] = reschedule(state.schedule[card.char], 'hard');
  saveState();
  const pos = state.deck.length > 1 ? 1 + Math.floor(Math.random() * state.deck.length) : state.deck.length;
  state.deck.splice(pos, 0, card);
  setTimeout(render, 210);
}

function showDone() {
  // "Full deck" = finished with every status filter on (Left + Know + Review).
  // Only then do we celebrate; a filtered run just nudges you to keep going.
  const fullDeck = ['left', 'know', 'review'].every(s => state.activeStatuses.has(s));
  const el = document.createElement('div'); el.className = 'done';
  el.innerHTML = `
    <div class="done-emoji">${fullDeck ? '🇨🇳' : '🤓'}</div>
    <h2>${fullDeck ? '你这中文太顶了吧！' : '继续学习'}</h2>
    <p>Known: <strong style="color:var(--green)">${state.known.size}</strong> &nbsp;·&nbsp; Review: <strong style="color:var(--blue)">${state.unknown.size}</strong></p>
    <div class="done-pills">
      <button class="pill" id="pReset">Reset deck</button>
    </div>`;
  deckEl.appendChild(el);
  // Reset deck: re-enable every status filter (Left / Know / Review) and rebuild
  // a fresh deck — but keep the user's progress (known / review marks).
  el.querySelector('#pReset').onclick = () => {
    state.activeStatuses = new Set(['left', 'know', 'review']);
    saveSettings();
    state.deck = state.groupsContent === 'words' ? buildWordDeck() : buildDeck(state.CHARACTERS);
    render();
    renderGroups();
  };
}

function attachDrag(cardEl) {
  const tl = cardEl.querySelector('.tint-l'), tr = cardEl.querySelector('.tint-r'), tu = cardEl.querySelector('.tint-u');
  const cl = cardEl.querySelector('.chip-l'),  cr = cardEl.querySelector('.chip-r'),  cu = cardEl.querySelector('.chip-u');
  let sx = 0, sy = 0, dx = 0, dy = 0, active = false, axis = null;

  function resetVisuals() {
    tl.style.opacity = tr.style.opacity = tu.style.opacity = '0';
    cl.style.opacity = cr.style.opacity = cu.style.opacity = '0';
  }
  function snap() {
    cardEl.classList.add('snap');
    cardEl.style.transform = ''; cardEl.style.opacity = '';
    resetVisuals();
  }
  function onStart(x, y) {
    sx = x; sy = y; dx = 0; dy = 0; active = true; axis = null;
    cardEl.classList.remove('fly', 'snap');
  }
  function applyVisuals() {
    if (axis === 'y') {
      if (dy >= 0) { resetVisuals(); cardEl.style.transform = ''; cardEl.style.opacity = ''; return; }
      const t = Math.min(1, Math.abs(dy) / 100);
      cardEl.style.transform = `translateY(${dy}px) rotate(${dx * 0.01}deg)`;
      cardEl.style.opacity = String(Math.max(.7, 1 - Math.abs(dy) / 360));
      tu.style.opacity = String(t * .85); cu.style.opacity = Math.abs(dy) > 50 ? '1' : '0';
      tl.style.opacity = tr.style.opacity = '0'; cl.style.opacity = cr.style.opacity = '0';
    } else {
      cardEl.style.transform = `translateX(${dx}px) rotate(${dx * 0.05}deg)`;
      cardEl.style.opacity = String(Math.max(.7, 1 - Math.abs(dx) / 360));
      const a = Math.min(1, Math.abs(dx) / 120);
      tl.style.opacity = dx < 0 ? String(a * .85) : '0'; tr.style.opacity = dx > 0 ? String(a * .85) : '0';
      cl.style.opacity = dx < -50 ? '1' : '0'; cr.style.opacity = dx > 50 ? '1' : '0';
      tu.style.opacity = '0'; cu.style.opacity = '0';
    }
  }
  function onMove(x, y) {
    if (!active) return;
    dx = x - sx; dy = y - sy;
    if (!axis) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8)
        axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      else return;
    }
    applyVisuals();
  }
  function onEnd() {
    if (!active) return; active = false;
    if (axis === 'y') {
      if (dy < -90) classifyReview(); else snap();
    } else if (axis === 'x') {
      if (dx > 100) classifyKnown(); else if (dx < -100) classifyLeft(); else snap();
    } else { snap(); }
  }

  cardEl.addEventListener('pointerdown', e => {
    onStart(e.clientX, e.clientY);
    if (!e.target.closest('.tz')) cardEl.setPointerCapture(e.pointerId);
  });
  cardEl.addEventListener('pointermove', e => onMove(e.clientX, e.clientY));
  cardEl.addEventListener('pointerup', e => {
    const moved = Math.abs(dx) > 8 || Math.abs(dy) > 8;
    if (!moved && e.target.closest('.tz')) { active = false; snap(); return; }
    onEnd();
  });
  cardEl.addEventListener('pointercancel', () => { active = false; snap(); });
}

export function init(src, forceNew) {
  if (forceNew) { state.known = new Set(); state.unknown = new Set(); state.schedule = {}; }
  const saved = !forceNew && loadState();
  if (saved && saved.schedule) state.schedule = saved.schedule;
  if (saved && saved.deckChars && saved.deckChars.length) {
    const charMap = Object.fromEntries(state.CHARACTERS.map(c => [c.char, c]));
    state.deck    = saved.deckChars.map(ch => charMap[ch]).filter(Boolean).filter(c => isAvailable(c.hsk));
    state.known   = new Set(saved.known   || []);
    state.unknown = new Set(saved.unknown || []);
    // A saved deck made entirely of word strings (e.g. left over from words mode)
    // maps to nothing here — fall back to a fresh build so we never show an empty deck.
    if (!state.deck.length) state.deck = buildDeck(src);
    else state.deckInitial = state.deck.length;   // restored mid-session deck
  } else {
    state.deck = buildDeck(src);
  }
  render();
}
