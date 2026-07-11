/* ── "LEARN SHUAZI" GUIDED TOUR ──
   An interactive, spotlight-style onboarding tour launched from
   Settings › Learn Shuazi. Each step drives the app to the relevant tab,
   highlights the UI element it's talking about (keeping it interactive), and
   shows a title + concise description with Back / Next / Skip controls.

   The dimming overlay uses an even-odd clip-path so the "hole" over the target
   is clipped away: the dim area still absorbs stray taps, but the highlighted
   element beneath the hole receives pointer events and stays usable (e.g. you
   can swipe a card during the Cards step).

   Completion is stored in localStorage, but the tour can be replayed anytime. */

import { t } from './i18n.js';
import { showTab, tourPrepareGroups, tourCollapseGroups, tourOpenHsk1, tourOpenRadicals, tourSetSort, setTourSuppressModal } from './ui.js';
import { playDemoSwipe } from './coach.js';

const SEEN_KEY = 'tour-completed';
export const tourSeen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ } };

const raf   = () => new Promise(r => requestAnimationFrame(() => r()));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll for an element (some grids are virtualized / rendered a frame late).
async function waitFor(getEl, { tries = 40, gap = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const el = getEl();
    if (el && el.getBoundingClientRect().width > 0) return el;
    await sleep(gap);
  }
  return getEl() || null;
}

// First HSK-1 tile that sits clearly within the viewport and above the tour
// card, so the spotlight lands on a tile the user can actually reach. The grid
// is virtualized, so which tiles exist in the DOM depends on the scroll offset.
function firstVisibleTile() {
  const tiles = document.querySelectorAll('#wgrid-1 .char-tile, #grid-1 .char-tile');
  const cardTop = document.querySelector('.tour-card')?.getBoundingClientRect().top ?? window.innerHeight;
  const limit = Math.min(cardTop, window.innerHeight) - 16;
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (r.width > 0 && r.top > 70 && r.bottom < limit) return t;
  }
  return null;
}

// Scroll a target to the middle of its scroller, then wait for it to settle
// (virtualized grids paint their tiles in response to the scroll).
async function scrollIntoCenter(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { el.scrollIntoView(); }
  await sleep(160);
  await raf();
}

// ── Step definitions ──
// Each: section (chip label key), tab to open, an async `locate` returning the
// element to highlight (null → centered card, full dim), and title/body keys.
// `pad` / `radius` shape the spotlight hole.
const STEPS = [
  // 0 · WELCOME — centered card with the RTFM image, no spotlight, over the Cards
  // screen. Shares the "Cards" section dot (no chip of its own) → 5 dots, not 6.
  { section: 'cards', noChip: true, tab: 'cards', image: './images/rtfm.png',
    title: 'tour.welcome.title', body: 'tour.welcome.body' },

  // 1 · CARDS — highlight the bottom "Cards" tab, explain the swipe directions.
  // Card pinned to the bottom but lifted clear of the tab bar so the spotlight
  // on the "Cards" tab stays visible beneath it.
  { section: 'cards', tab: 'cards', cardPos: 'bottom', cardLift: true,
    locate: () => waitFor(() => document.getElementById('tab-cards')),
    title: 'tour.cards1.title', body: 'tour.cards1.body', pad: 6, radius: 16 },
  // 2 · CARDS — no spotlight; play the swipe demo on the real top card instead.
  { section: 'cards', tab: 'cards', dim: false, cardPos: 'bottom', demo: true,
    title: 'tour.cards2.title', body: 'tour.cards2.body' },

  // 2 · GROUPS — intro: highlight the bottom "Groups" tab with the grids closed;
  // message sits just above the tab.
  { section: 'groups', tab: 'groups', prepare: () => tourCollapseGroups(), cardPos: 'bottom', cardLift: true,
    locate: () => waitFor(() => document.getElementById('tab-groups')),
    title: 'tour.groups1.title', body: 'tour.groups1.body', pad: 6, radius: 16 },
  // Open a grid: spotlight the (collapsed) HSK 1 header so the user learns to
  // tap it to reveal its characters/words. The Radicals/Components sections
  // share `.hsk-group`, so key off the HSK-1 badge to pick the right header.
  { section: 'groups', tab: 'groups', prepare: () => tourCollapseGroups(),
    locate: async () => {
      const header = () => document.querySelector('#groups-content .badge.hsk-1')?.closest('.hsk-group-header');
      const h = await waitFor(header);
      await scrollIntoCenter(h);
      return header() || h;
    },
    title: 'tour.groupsOpen.title', body: 'tour.groupsOpen.body', pad: 6, radius: 14 },
  // Mark a character: HSK 1 grid guaranteed open, spotlight its first on-screen
  // tile and teach the long-press-to-mark gesture. Aligning the header to the
  // top (rather than centering the tall grid) keeps the first tiles in view.
  { section: 'groups', tab: 'groups', prepare: () => tourOpenHsk1(),
    locate: async () => {
      const header = () => document.querySelector('#groups-content .badge.hsk-1')?.closest('.hsk-group-header');
      const h = await waitFor(header);
      if (h) { try { h.scrollIntoView({ block: 'start' }); } catch {} await sleep(220); }
      const tile = await waitFor(firstVisibleTile, { tries: 25 });
      return tile || header();
    },
    title: 'tour.groupsMark.title', body: 'tour.groupsMark.body', pad: 5, radius: 12, suppressModal: true },
  // See details: HSK 1 grid open, spotlight a tile and let a plain tap open its
  // detail modal (the tour drops below the modal so it's fully usable).
  { section: 'groups', tab: 'groups', prepare: () => tourOpenHsk1(), underModal: true,
    locate: async () => {
      const header = () => document.querySelector('#groups-content .badge.hsk-1')?.closest('.hsk-group-header');
      const h = await waitFor(header);
      if (h) { try { h.scrollIntoView({ block: 'start' }); } catch {} await sleep(220); }
      const tile = await waitFor(firstVisibleTile, { tries: 25 });
      return tile || header();
    },
    title: 'tour.groupsTap.title', body: 'tour.groupsTap.body', pad: 5, radius: 12 },
  // Open a filter: grids closed; spotlight the Radicals header so the user taps
  // it (or Components) to reveal the filter grid.
  { section: 'groups', tab: 'groups', prepare: () => tourCollapseGroups(),
    locate: async () => {
      const header = () => document.querySelector('#groups-content .badge.radical')?.closest('.hsk-group-header');
      const h = await waitFor(header);
      await scrollIntoCenter(h);
      return header() || h;
    },
    title: 'tour.groupsOpenFilter.title', body: 'tour.groupsOpenFilter.body', pad: 6, radius: 14 },
  // Filter: open the Radicals grid and spotlight its first tile — long-pressing
  // it filters the grid. A short tap must not pop the radical modal, so suppress.
  { section: 'groups', tab: 'groups', prepare: () => tourOpenRadicals(), suppressModal: true,
    watchContent: true,
    // After the long-press filters, renderGroups rebuilds the tiles; re-anchor to
    // the now-active radical so it keeps its spotlight.
    relocate: () => document.querySelector('#groups-content .radical-tile.active')
      || document.querySelector('#groups-content .radical-tile'),
    locate: async () => {
      const first = () => document.querySelector('#groups-content .radical-tile');
      const t = await waitFor(first);
      await scrollIntoCenter(t);
      return first() || t;
    },
    title: 'tour.groups3.title', body: 'tour.groups3.body', pad: 5, radius: 12 },
  // Sort
  { section: 'groups', tab: 'groups', prepare: () => tourPrepareGroups(),
    locate: () => waitFor(() => document.getElementById('sortBtn')),
    title: 'tour.groups2.title', body: 'tour.groups2.body', pad: 8, radius: 999 },
  // 3 · SLANG — highlight the bottom "Slang" tab with the message above it…
  { section: 'slang', tab: 'slang', cardPos: 'bottom', cardLift: true,
    locate: () => waitFor(() => document.getElementById('tab-slang')),
    title: 'tour.slang.title', body: 'tour.slang.body', pad: 6, radius: 16 },
  // …then reveal the whole screen (no dim) so the user can swipe the slang cards.
  { section: 'slang', tab: 'slang', dim: false, cardPos: 'bottom',
    title: 'tour.slangSwipe.title', body: 'tour.slangSwipe.body' },

  // 4 · TRANSLATE — highlight the bottom "Translate" tab with the message above it.
  { section: 'translate', tab: 'translator', cardPos: 'bottom', cardLift: true,
    locate: () => waitFor(() => document.getElementById('tab-translator')),
    title: 'tour.translate.title', body: 'tour.translate.body', pad: 6, radius: 16 },

  // 5 · PROFILE — highlight the bottom "Profile" tab with the message above it.
  { section: 'deck', tab: 'profile', cardPos: 'bottom', cardLift: true,
    locate: () => waitFor(() => document.getElementById('tab-profile')),
    title: 'tour.profile.title', body: 'tour.profile.body', pad: 6, radius: 16 },

  // 6 · DECK & PROGRESS (profile)
  { section: 'deck', tab: 'profile',
    locate: async () => {
      const el = await waitFor(() => document.querySelector('#profile-scroll .groups-filter-row'));
      const sec = el?.closest('.profile-section') || el;
      await scrollIntoCenter(sec);
      return sec;
    },
    title: 'tour.deck1.title', body: 'tour.deck1.body', pad: 8, radius: 16 },
  { section: 'deck', tab: 'profile',
    locate: async () => {
      const known = await waitFor(() => document.getElementById('p-known'));
      const sec = known?.closest('.profile-section') || known;
      await scrollIntoCenter(sec);
      return sec;
    },
    title: 'tour.deck2.title', body: 'tour.deck2.body', pad: 8, radius: 16 },
  { section: 'deck', tab: 'profile',
    locate: async () => {
      const row = await waitFor(() => document.querySelector('#profile-scroll .hsk-filter-row'));
      const sec = row?.closest('.profile-section') || row;
      await scrollIntoCenter(sec);
      return sec;
    },
    title: 'tour.deck3.title', body: 'tour.deck3.body', pad: 8, radius: 16 },
];

// One progress dot per section (Welcome, Cards, Groups, Slang, Translate, Deck)
// instead of one per step — 17 dots was too many. Order follows first appearance.
const SECTIONS = [...new Set(STEPS.map(s => s.section))];

// ── Engine state ──
let overlay, ring, card, els = null;
let index = 0;
let active = false;
let token = 0;   // guards against a slow locate() landing after Next/close
let savedSort = null;   // user's grid sort, restored when the tour ends
let prevTab = null;     // last shown tab — skip re-showing (and re-rendering) it

function buildDom() {
  overlay = document.createElement('div');
  overlay.className = 'tour-overlay';
  // Dim area swallows stray taps so the user can't wander off mid-tour; the
  // clipped hole passes touches through to the highlighted element.
  overlay.addEventListener('pointerdown', e => e.stopPropagation());
  overlay.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  ring = document.createElement('div');
  ring.className = 'tour-ring';

  card = document.createElement('div');
  card.className = 'tour-card';
  card.innerHTML = `
    <div class="tour-card-top">
      <span class="tour-section"></span>
      <button class="tour-skip" type="button"></button>
    </div>
    <img class="tour-img" alt="" style="display:none"/>
    <div class="tour-title"></div>
    <div class="tour-body"></div>
    <div class="tour-nav">
      <div class="tour-dots"></div>
      <div class="tour-actions">
        <button class="tour-back" type="button"></button>
        <button class="tour-next" type="button"></button>
      </div>
    </div>`;

  els = {
    section: card.querySelector('.tour-section'),
    skip:    card.querySelector('.tour-skip'),
    img:     card.querySelector('.tour-img'),
    title:   card.querySelector('.tour-title'),
    body:    card.querySelector('.tour-body'),
    dots:    card.querySelector('.tour-dots'),
    back:    card.querySelector('.tour-back'),
    next:    card.querySelector('.tour-next'),
  };

  const goNext = () => { if (index < STEPS.length - 1) goToStep(index + 1); else endTour(); };
  const goBack = () => { if (index > 0) goToStep(index - 1); };

  els.skip.addEventListener('click', () => endTour(true));
  els.back.addEventListener('click', goBack);
  els.next.addEventListener('click', goNext);

  // Swipe the card left/right to go next/back (in addition to the buttons).
  // `touch-action: pan-y` on the card leaves horizontal gestures free for us,
  // while vertical drags still scroll the card's content.
  let swX = 0, swY = 0, swId = null;
  card.addEventListener('pointerdown', e => { swId = e.pointerId; swX = e.clientX; swY = e.clientY; });
  card.addEventListener('pointerup', e => {
    if (e.pointerId !== swId) return;
    swId = null;
    const dx = e.clientX - swX, dy = e.clientY - swY;
    if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy)) return;   // not a horizontal swipe
    if (dx < 0) goNext(); else goBack();
  });
  card.addEventListener('pointercancel', () => { swId = null; });

  els.dots.innerHTML = SECTIONS.map(sec =>
    `<span class="tour-dot" title="${t('tour.section.' + sec)}"></span>`).join('');

  document.body.append(overlay, ring, card);
}

function clipFor(rect) {
  const W = window.innerWidth, H = window.innerHeight;
  if (!rect) { overlay.style.clipPath = 'none'; return; }
  const rad = Math.min(rect.radius, rect.w / 2, rect.h / 2);
  const { x, y } = rect, x2 = x + rect.w, y2 = y + rect.h;
  overlay.style.clipPath =
    `path(evenodd,'M0,0 H${W} V${H} H0 Z ` +
    `M${x + rad},${y} H${x2 - rad} A${rad},${rad} 0 0 1 ${x2},${y + rad} ` +
    `V${y2 - rad} A${rad},${rad} 0 0 1 ${x2 - rad},${y2} ` +
    `H${x + rad} A${rad},${rad} 0 0 1 ${x},${y2 - rad} ` +
    `V${y + rad} A${rad},${rad} 0 0 1 ${x + rad},${y} Z')`;
}

// Measure the current step's element and paint the spotlight + place the card.
function place(el, step) {
  const W = window.innerWidth, H = window.innerHeight;
  // Some steps (e.g. the swipe demo) show no spotlight and don't dim the app, so
  // the animation underneath stays fully visible and interactive.
  const noDim = step.dim === false;
  overlay.classList.toggle('no-dim', noDim);
  // Some steps invite opening the detail modal, which sits at z-index 100; drop
  // the whole tour beneath it so the modal is fully visible and interactive.
  for (const n of [overlay, ring, card]) n.classList.toggle('under-modal', !!step.underModal);

  let rect = null;
  if (el && !noDim) {
    const r = el.getBoundingClientRect();
    const pad = step.pad ?? 6;
    const x = Math.max(6, r.left - pad);
    const y = Math.max(6, r.top - pad);
    const x2 = Math.min(W - 6, r.right + pad);
    const y2 = Math.min(H - 6, r.bottom + pad);
    rect = { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y), radius: step.radius ?? 14 };
  }

  clipFor(rect);

  if (rect && rect.w > 0 && rect.h > 0) {
    ring.style.display = 'block';
    ring.style.left   = rect.x + 'px';
    ring.style.top    = rect.y + 'px';
    ring.style.width  = rect.w + 'px';
    ring.style.height = rect.h + 'px';
    ring.style.borderRadius = Math.min(rect.radius, rect.w / 2, rect.h / 2) + 'px';
  } else {
    ring.style.display = 'none';
  }

  // Keep the card clear of the highlighted element: below it when the target is
  // in the top half, above it when in the bottom half, centered when unknown.
  // A step may pin the card explicitly via `cardPos`.
  card.classList.remove('pos-top', 'pos-bottom', 'pos-center');
  const pos = step.cardPos || (!rect ? 'center' : (rect.y + rect.h / 2 < H / 2 ? 'bottom' : 'top'));
  card.classList.add('pos-' + pos);
  // Lift a bottom-pinned card above the tab bar when it would otherwise cover
  // the spotlight sitting there (e.g. the "Cards" tab on step 1).
  card.classList.toggle('lift', !!step.cardLift);
}

// Track the current target so the spotlight can re-adapt when it changes size —
// e.g. the "Sort" button grows/shrinks as tapping it cycles the mode label.
let curEl = null, curStep = null, targetObs = null;
function observeTarget(el, step) {
  curEl = el; curStep = step;
  if (targetObs) { targetObs.disconnect(); targetObs = null; }
  if (!el || typeof ResizeObserver === 'undefined') return;
  targetObs = new ResizeObserver(() => { if (active && curEl === el) place(el, step); });
  targetObs.observe(el);
}
function stopObservingTarget() {
  if (targetObs) { targetObs.disconnect(); targetObs = null; }
  if (contentObs) { contentObs.disconnect(); contentObs = null; }
  curEl = curStep = null;
}

// Some steps re-render the grid as the user acts on the spotlit element (e.g.
// long-pressing a radical to filter rebuilds every tile). Watch #groups-content
// and re-anchor the spotlight to the step's `relocate()` target so the highlight
// stays on the radical after it becomes active.
let contentObs = null;
function watchContent(step) {
  if (contentObs) { contentObs.disconnect(); contentObs = null; }
  if (!step || !step.watchContent || !step.relocate || typeof MutationObserver === 'undefined') return;
  const content = document.getElementById('groups-content');
  if (!content) return;
  let queued = false;
  contentObs = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!active) return;
      const el = step.relocate();
      if (el) { place(el, step); observeTarget(el, step); }
    });
  });
  contentObs.observe(content, { childList: true, subtree: true });
}

function renderCardText(step) {
  if (step.section && !step.noChip) { els.section.textContent = t('tour.section.' + step.section); els.section.style.display = ''; }
  else els.section.style.display = 'none';
  if (step.image) { els.img.src = step.image; els.img.style.display = ''; }
  else els.img.style.display = 'none';
  els.title.textContent   = t(step.title);
  els.body.innerHTML      = t(step.body);
  // Easter egg: tapping "the manual" toggles it to "the fucking manual".
  const manual = els.body.querySelector('.tour-manual');
  if (manual) manual.addEventListener('click', () => {
    manual.textContent = manual.textContent === manual.dataset.on ? manual.dataset.off : manual.dataset.on;
  });
  els.back.textContent    = t('tour.back');
  els.back.style.visibility = index > 0 ? 'visible' : 'hidden';
  els.skip.textContent    = t('tour.skip');
  els.next.textContent    = index < STEPS.length - 1 ? t('tour.next') : t('tour.done');
  const curSec = SECTIONS.indexOf(step.section);
  els.dots.querySelectorAll('.tour-dot').forEach((d, i) => {
    d.classList.toggle('seen', i < curSec);      // completed sections
    d.classList.toggle('active', i === curSec);  // current section
  });
}

async function goToStep(i) {
  index = i;
  const step = STEPS[i];
  const myToken = ++token;

  stopObservingTarget();   // drop the previous step's observers before re-anchoring

  // Only the "mark a character" step blocks tap-to-open-modal.
  setTourSuppressModal(!!step.suppressModal);

  renderCardText(step);

  // Drive the app to the right tab (only when it actually changes — re-showing a
  // tab re-renders it, which reads as a "reload"), run any per-step setup, then
  // let the screen transition (opacity 220ms) and any re-render settle.
  const switched = step.tab && step.tab !== prevTab;
  if (switched) showTab(step.tab);
  if (step.tab) prevTab = step.tab;
  if (step.prepare) { try { step.prepare(); } catch (e) { console.error('tour prepare failed', e); } }
  // Only wait for a screen transition / re-render to settle when one happened.
  if (switched || step.prepare) { await sleep(240); if (myToken !== token || !active) return; }

  const el = step.locate ? await step.locate() : null;
  if (myToken !== token || !active) return;   // user advanced/closed while we waited

  // First reveal: snap the card into its positioned state with the transition off,
  // then fade it in — otherwise applying the position class animates `transform`
  // ~200px from the card's base position (a visible slide). Later steps keep the
  // transition so the card glides smoothly between positions.
  const firstReveal = !card.classList.contains('show');
  if (firstReveal) card.style.transition = 'none';
  place(el, step);
  if (firstReveal) {
    void card.offsetWidth;                          // commit the un-transitioned position
    card.style.transition = '';
    requestAnimationFrame(() => { if (active && myToken === token) card.classList.add('show'); });
  }
  observeTarget(el, step);          // keep the spotlight matched to the target's size
  watchContent(step);               // re-anchor the spotlight when the grid re-renders
  if (step.demo) playDemoSwipe();   // replay the card-swipe animation for this step
}

export function startTour() {
  if (active) return;
  active = true;
  prevTab = null;
  document.body.classList.add('tour-active');   // suppress app swipe gestures (Settings / Recents)
  savedSort = tourSetSort('frequency');   // show the grid sorted by frequency during the tour
  buildDom();
  requestAnimationFrame(() => { overlay.classList.add('show'); ring.classList.add('show'); });
  window.addEventListener('resize', reposition, { passive: true });
  window.addEventListener('orientationchange', reposition, { passive: true });
  goToStep(0);
}

// Re-measure the current step's element on viewport changes (no re-navigation).
let repositionQueued = false;
function reposition() {
  if (!active || repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(async () => {
    repositionQueued = false;
    const step = STEPS[index];
    const el = step.locate ? await step.locate() : null;
    if (active) { place(el, step); observeTarget(el, step); }
  });
}

function endTour() {
  if (!active) return;
  active = false;
  token++;
  markSeen();
  document.body.classList.remove('tour-active');
  setTourSuppressModal(false);   // restore normal tap-to-open behaviour
  if (savedSort != null) { tourSetSort(savedSort); savedSort = null; }   // restore sort
  stopObservingTarget();
  window.removeEventListener('resize', reposition);
  window.removeEventListener('orientationchange', reposition);
  overlay.classList.remove('show');
  card.classList.remove('show');
  ring.classList.remove('show');
  const nodes = [overlay, card, ring];
  setTimeout(() => nodes.forEach(n => n && n.remove()), 260);
  overlay = ring = card = els = null;
}
