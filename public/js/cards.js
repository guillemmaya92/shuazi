import { FREE_HSK } from './config.js';
import { state } from './state.js';
import { saveState, loadState } from './progress.js';
import { renderGroups } from './ui.js';

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

export function buildDeck(src) {
  const filtered = src.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
  const cards = filtered.filter(c => {
    if (state.known.has(c.char))   return state.activeStatuses.has('know');
    if (state.unknown.has(c.char)) return state.activeStatuses.has('review');
    return state.activeStatuses.has('left');
  });
  shuffle(cards);
  return cards;
}

const deckEl  = document.getElementById('deck');
const vRest   = document.getElementById('vRest');
const vKnown  = document.getElementById('vKnown');
const vRepaso = document.getElementById('vRepaso');

export function stats() {
  const filtered = state.CHARACTERS.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
  const knownN   = filtered.filter(c => state.known.has(c.char)).length;
  const reviewN  = filtered.filter(c => state.unknown.has(c.char)).length;
  vRest.textContent   = filtered.length - knownN - reviewN;
  vKnown.textContent  = knownN;
  vRepaso.textContent = reviewN;
  saveState();
  renderGroups();
}

const PAGES = 2;

function makeCard(card, isStack) {
  const el = document.createElement('article');
  el.className = 'card ' + (isStack ? 'stack-under' : 'top');
  el.dataset.page = '0';

  const cardWords = (state.wordsByChar[card.char] || []).slice(0, 4);
  const wordsHTML = cardWords.map(w =>
    `<div class="word-item"><strong>${w.id}</strong>${w.pinyin ? `<span class="word-pinyin">${w.pinyin}</span>` : ''}<span class="word-meaning">${w.meaning}</span></div>`
  ).join('');

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
      <button class="tz tz-left"   tabindex="-1"></button>
      <button class="tz tz-center" tabindex="-1"></button>
      <button class="tz tz-right"  tabindex="-1"></button>
    </div>
    <div class="pages" id="pages">
      <div class="page" style="justify-content:space-between;">
        <div class="card-top"><span class="prog"></span></div>
        <div class="hanzi-wrap"><div class="hanzi">${card.char}</div></div>
        <div class="answer-area" id="aa"></div>
        <div class="card-bottom">
          <span class="tap-hint" id="tap-hint">Tap center to reveal</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="hsk-pill hsk-${card.hsk}">HSK ${card.hsk}</span>
          </div>
        </div>
      </div>
      <div class="page info-page" style="padding-top:44px">
        <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
          <div class="info-cell"><div class="lbl">Hanzi</div><div class="val" style="font-family:'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif;font-size:1.6rem">${card.char}</div></div>
          <div class="info-cell"><div class="lbl">Pinyin</div><div class="val">${card.pinyin}</div></div>
          <div class="info-cell"><div class="lbl">Level</div><div class="val"><span class="hsk-pill hsk-${card.hsk}">HSK ${card.hsk}</span></div></div>
          <div class="info-cell full"><div class="lbl">Meaning</div><div class="val">${card.meaning}</div></div>
        </div>
        <div class="words-title">Compound words</div>
        <div class="words-list">${wordsHTML}</div>
      </div>
    </div>
  `;

  const pages = el.querySelector('#pages');
  const segs  = el.querySelectorAll('.seg');
  const tzL   = el.querySelector('.tz-left');
  const tzC   = el.querySelector('.tz-center');
  const tzR   = el.querySelector('.tz-right');
  const aa    = el.querySelector('#aa');

  function goPage(n) {
    el.dataset.page = String(n);
    pages.style.transform = `translateX(-${n * 100}%)`;
    segs.forEach((s, i) => s.classList.toggle('active', i === n));
  }

  tzL.addEventListener('click', e => { e.stopPropagation(); const c = +el.dataset.page; if (c > 0) goPage(c - 1); });
  tzR.addEventListener('click', e => { e.stopPropagation(); const c = +el.dataset.page; if (c < PAGES - 1) goPage(c + 1); });
  tzC.addEventListener('click', e => {
    e.stopPropagation();
    if (+el.dataset.page !== 0) return;
    const tapHint = el.querySelector('#tap-hint');
    if (el.dataset.answer === '1') {
      el.dataset.answer = '0'; aa.innerHTML = '';
      tapHint.style.visibility = 'visible';
    } else {
      el.dataset.answer = '1';
      tapHint.style.visibility = 'hidden';
      const w = (state.wordsByChar[card.char] || [])[0];
      const exHTML = w
        ? `<span style="display:block;color:var(--txt);font-size:.9rem;font-family:'PingFang SC','Hiragino Sans GB',sans-serif;font-weight:600;line-height:1.3">${w.id}</span><span style="display:block;color:var(--muted);font-size:.75rem;font-weight:300;line-height:1.3">${w.pinyin}</span><span style="display:block;color:var(--faint);font-size:.75rem;font-weight:300;line-height:1.3">${w.meaning}</span>`
        : '—';
      aa.innerHTML = `<div class="answer-block">
        <div class="ans-pinyin">${card.pinyin}</div>
        <div class="ans-meaning">${card.meaning}</div>
        <div class="ans-example"><span>Example</span>${exHTML}</div>
        <div class="ans-hint">Tap right → for more info</div>
      </div>`;
    }
  });

  if (!isStack) attachDrag(el);
  return el;
}

export function render() {
  deckEl.innerHTML = ''; stats();
  if (state.deck.length === 0) { showDone(); return; }
  if (state.deck.length > 1) deckEl.appendChild(makeCard(state.deck[1], true));
  deckEl.appendChild(makeCard(state.deck[0], false));
}

export function classifyKnown() {
  if (state.deck.length === 0) return;
  const top = deckEl.querySelector('.card.top'); if (!top) return;
  top.classList.add('fly');
  top.style.transform = 'translateX(140%) rotate(16deg)';
  top.style.opacity = '0';
  const card = state.deck.shift();
  state.known.add(card.char); state.unknown.delete(card.char);
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
  const pos = state.deck.length > 1 ? 1 + Math.floor(Math.random() * state.deck.length) : state.deck.length;
  state.deck.splice(pos, 0, card);
  setTimeout(render, 210);
}

function showDone() {
  const el = document.createElement('div'); el.className = 'done';
  el.innerHTML = `
    <div class="done-emoji">🇨🇳</div>
    <h2>你这中文太顶了吧！</h2>
    <p>Known: <strong style="color:var(--green)">${state.known.size}</strong> &nbsp;·&nbsp; Review: <strong style="color:var(--blue)">${state.unknown.size}</strong></p>
    <div class="done-pills">
      <button class="pill" id="pW">Review hard ones</button>
      <button class="pill" id="pA">Reset all</button>
    </div>`;
  deckEl.appendChild(el);
  el.querySelector('#pW').onclick = () => { state.deck = buildDeck(state.CHARACTERS); render(); };
  el.querySelector('#pA').onclick = () => init(state.CHARACTERS, true);
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
  function onMove(x, y) {
    if (!active) return;
    dx = x - sx; dy = y - sy;
    if (!axis) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8)
        axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      else return;
    }
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
  if (forceNew) { state.known = new Set(); state.unknown = new Set(); }
  const saved = !forceNew && loadState();
  if (saved && saved.deckChars && saved.deckChars.length) {
    const charMap = Object.fromEntries(state.CHARACTERS.map(c => [c.char, c]));
    state.deck    = saved.deckChars.map(ch => charMap[ch]).filter(Boolean).filter(c => isAvailable(c.hsk));
    state.known   = new Set(saved.known   || []);
    state.unknown = new Set(saved.unknown || []);
  } else {
    state.deck = buildDeck(src);
  }
  render();
}
