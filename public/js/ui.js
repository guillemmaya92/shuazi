import { supa, hskLabel } from './config.js';
import { state } from './state.js';
import { saveState, saveSettings, clearProgressInSupabase } from './progress.js';
import { startCheckout, deleteAccount, checkAccount } from './auth.js';
import { buildDeck, buildWordDeck, render, classifyKnown, classifyLeft, classifyReview, stats, init, isAvailable, normalizePinyin, fetchWordsForChar, fetchPhrasesForWord, updateDeckProgress } from './cards.js';
import { initTranslator, speak } from './translator.js';
import { setupPullRefresh } from './pull-refresh.js';
import { refreshGroupsScrollbar } from './groups-scrollbar.js';
import { applyLanguage, applyStaticTranslations, t } from './i18n.js';
import { mountVirtualGrid, destroyAllVirtualGrids, VIRTUALIZE_THRESHOLD } from './virtual-grid.js';
import { maybeShowGroupsCoach } from './coach.js';
import { openStrokeOrder } from './stroke-order.js';
import { startTour } from './tour.js';

// Speaker icon + helper for the per-modal "listen" button (mirrors cards.js).
const MODAL_LISTEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7 6.6 8.2H3v7.6h3.6L11 19.3z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.5 6.5a9 9 0 0 1 0 11"/></svg>';

function attachModalListen(text) {
  const btn = modalContent.querySelector('.cell-listen-btn');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    speak(text, on => btn.classList.toggle('playing', on));
  });
}

// Radical/component glyphs (e.g. 氵) are often non-standalone forms the TTS can't
// voice, and raw pinyin ("shuǐ") gets read as letters. So resolve to a real hanzi
// with the same reading — the glyph itself if it's a known character, otherwise any
// character sharing its exact pinyin (same sound + tone). Falls back to the glyph.
function hanziForReading(glyph, pinyin) {
  if (state.CHARACTERS.some(c => c.char === glyph)) return glyph;
  const match = pinyin && state.CHARACTERS.find(c => c.pinyin === pinyin);
  return match ? match.char : glyph;
}

/* ── GROUPS ── */
const collapsedGroups = new Set([1, 2, 3, 4, 5, 6, 7]);
let radicalsCollapsed = true;
let activeRadical = null;
let componentsCollapsed = true;
let activeComponent = null; // component id
const collapsedWordGroups = new Set([1, 2, 3, 4, 5, 6, 7]);

// Expand/collapse a .char-grid-wrap with a height animation. The expanded
// steady state is max-height:none (set in CSS) so very tall grids — e.g. HSK7
// with 5000+ tiles — are never clipped. We only pin a pixel height for the
// duration of the transition so it can animate to/from 0, then release it.
function animateGridWrap(wrap, open) {
  if (open) {
    wrap.style.maxHeight = '0px';
    wrap.classList.remove('collapsed');
    void wrap.offsetHeight;                       // reflow at 0 before growing
    wrap.style.maxHeight = wrap.scrollHeight + 'px';
    wrap.addEventListener('transitionend', function done(e) {
      if (e.target !== wrap || e.propertyName !== 'max-height') return;
      wrap.style.maxHeight = 'none';              // uncap so content can never clip
      wrap.removeEventListener('transitionend', done);
    });
  } else {
    wrap.style.maxHeight = wrap.scrollHeight + 'px';  // pin current height
    void wrap.offsetHeight;
    wrap.classList.add('collapsed');                  // .collapsed forces max-height:0 (animates)
  }
}

function gridGroupLabel(item, index, total) {
  const s = state.gridSort;
  if (s === 'pinyin') {
    const py = (item.pinyin ?? '').trim();
    if (!py) return '?';
    const base = py.normalize('NFD')[0];
    const code = base.charCodeAt(0);
    if (code >= 65 && code <= 90) return base;
    if (code >= 97 && code <= 122) return base.toUpperCase();
    return '?';
  }
  if (s === 'productive' || s === 'frequency') {
    const b = Math.floor(index / 100);
    const start = b * 100 + 1;
    const end = total !== undefined ? Math.min(b * 100 + 100, total) : b * 100 + 100;
    return `${start}–${end}`;
  }
  if (s === 'stroke') return String(item.stroke ?? '?');
  if (s === 'pos') return state.POS_TAGS?.[item.pos] || null;
  return null;
}

// Tile prototypes cloned per render. cloneNode(true) is much cheaper than parsing
// `innerHTML` for each of the thousands of tiles in a big level (e.g. HSK7 has
// ~5000), and we no longer emit the .toggle-btn (it is display:none on every
// .char-tile, so it was pure dead DOM — two prototypes, ~2 nodes saved per tile).
const charTileProto = document.createElement('button');
charTileProto.className = 'char-tile';
charTileProto.innerHTML = '<div class="tc"></div><div class="tp"></div>';
const wordTileProto = document.createElement('button');
wordTileProto.className = 'char-tile word-tile';
wordTileProto.innerHTML = '<div class="tc"></div><div class="tp"></div>';

// Empty a grid, tearing down its virtual scroller first if it has one (so the
// scroll/resize listeners are removed instead of leaking).
function clearGrid(g) {
  if (g._vgrid) { g._vgrid.destroy(); g._vgrid = null; }
  else g.replaceChildren();
}

export function renderGroups() {
  const scrollEl = document.getElementById('groups-scroll');
  const container = document.getElementById('groups-content');
  const levels = [1, 2, 3, 4, 5, 6, 7];
  const q = state.gridSearch.trim();
  // Mirror the deck's status filter on the grid: an item passes when its
  // status (known / review / left) is among the active status filters.
  const passesStatus = key => state.activeStatuses.has(
    state.known.has(key) ? 'know' : state.unknown.has(key) ? 'review' : 'left');
  // Drop any live virtual grids before we throw away their DOM, so the scroll /
  // resize listeners they put on the shared scroller don't leak across renders.
  destroyAllVirtualGrids();
  container.innerHTML = '';
  scrollEl.classList.toggle('hide-pinyin', !state.showPinyin);

  const sectionTitle = (text, sub, rightHTML = '') => {
    const h = document.createElement('div');
    h.className = 'groups-section-title';
    h.innerHTML = `<div class="groups-section-titletext">${text}<span class="groups-section-sub">${sub}</span></div>${rightHTML}`;
    container.appendChild(h);
  };

  // A filter active in one grid forces the other grid closed.
  const radClosed  = activeComponent ? true : (q ? false : radicalsCollapsed);
  const compClosed = activeRadical   ? true : (q ? false : componentsCollapsed);

  if (state.RADICALS?.length || state.COMPONENTS?.length) sectionTitle(t('groups.filtersTitle'), t('groups.filtersHint'));

  if (state.RADICALS?.length) {
    let sortedRadicals = [...state.RADICALS];
    if (q) {
      const exact    = q.startsWith('"') && q.endsWith('"') && q.length > 2;
      const term     = exact ? q.slice(1, -1) : q;
      const normTerm = normalizePinyin(term).replace(/\s+/g, '');
      sortedRadicals = sortedRadicals.filter(r => {
        const normPinyin = normalizePinyin(r.pinyin ?? '').replace(/\s+/g, '');
        if (exact) return r.radical === term || normPinyin === normTerm;
        return r.radical.includes(term) || normPinyin.includes(normTerm);
      });
    }

    const radDiv = document.createElement('div');
    radDiv.className = 'hsk-group';
    radDiv.innerHTML = `
      <div class="hsk-group-header">
        <div class="hsk-group-label">
          <span class="badge radical">${t('badge.radicals')}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--faint);flex-shrink:0"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          <span class="count">${q ? `${sortedRadicals.length} / ${state.RADICALS.length}` : `${state.RADICALS.length}`} ${t('count.radicals')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <svg class="chevron ${radClosed ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="char-grid-wrap ${radClosed ? 'collapsed' : ''}"><div class="char-grid"></div></div>
    `;
    container.appendChild(radDiv);

    const radHeader = radDiv.querySelector('.hsk-group-header');
    const radWrap   = radDiv.querySelector('.char-grid-wrap');
    const radGrid   = radDiv.querySelector('.char-grid');
    const radChev   = radDiv.querySelector('.chevron');
    if (activeRadical) radGrid.classList.add('radical-filtered');

    // Radicals have no POS, so the 'pos' sort falls back to alphabetical (pinyin).
    if (state.gridSort === 'pinyin' || state.gridSort === 'pos') sortedRadicals.sort((a, b) => a.pinyin.localeCompare(b.pinyin));
    else if (state.gridSort === 'productive') sortedRadicals.sort((a, b) => (Number(b.productive) || 0) - (Number(a.productive) || 0));
    else if (state.gridSort === 'frequency')  sortedRadicals.sort((a, b) => (Number(b.frequency)  || 0) - (Number(a.frequency)  || 0));
    else if (state.gridSort === 'stroke')     sortedRadicals.sort((a, b) => (Number(a.stroke)      || 0) - (Number(b.stroke)      || 0));
    else                                      sortedRadicals.sort((a, b) => Number(a.id) - Number(b.id));

    const radicalsInChars = new Set(state.CHARACTERS.map(c => c.radical));
    function renderRadicalTiles() {
      let lastRadLabel = null;
      const showRadLabels = !activeRadical && !q;
      sortedRadicals.forEach((rad, index) => {
        const lbl = showRadLabels ? gridGroupLabel(rad, index, sortedRadicals.length) : null;
        if (lbl !== null && lbl !== lastRadLabel) {
          lastRadLabel = lbl;
          const sep = document.createElement('div');
          sep.className = 'char-grid-label';
          sep.textContent = lbl;
          radGrid.appendChild(sep);
        }
        const tile = document.createElement('button');
        const isEmpty = !radicalsInChars.has(rad.radical);
        tile.className = 'char-tile radical-tile' + (rad.radical === activeRadical ? ' active' : '') + (isEmpty ? ' empty' : '');
        tile.title = `${rad.meaning} · ${rad.stroke} stroke${rad.stroke === '1' ? '' : 's'}`;
        tile.setAttribute('aria-label', `${rad.radical}, ${rad.pinyin}, ${rad.meaning}`);
        tile.innerHTML = `<div class="tc">${rad.radical}</div><div class="tp">${rad.pinyin}</div>`;
        let radPressTimer = null;
        tile.addEventListener('pointerdown', e => {
          e.stopPropagation();
          radPressTimer = setTimeout(() => {
            radPressTimer = null;
            activeRadical = activeRadical === rad.radical ? null : rad.radical;
            activeComponent = null;
            radicalsCollapsed = false;   // keep the Radicals grid open after the search bar closes
            closeSearchBar();
            renderGroups();
            if (navigator.vibrate) navigator.vibrate(30);
          }, 450);
        });
        tile.addEventListener('pointerup', () => {
          if (radPressTimer) { clearTimeout(radPressTimer); radPressTimer = null; openRadicalModal(rad); }
        });
        tile.addEventListener('pointercancel', () => { if (radPressTimer) { clearTimeout(radPressTimer); radPressTimer = null; } });
        tile.addEventListener('pointermove', e => { if (radPressTimer && (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6)) { clearTimeout(radPressTimer); radPressTimer = null; } });
        tile.addEventListener('contextmenu', e => e.preventDefault());
        radGrid.appendChild(tile);
      });
    }

    radHeader.addEventListener('click', () => {
      if (radicalsCollapsed) {
        radicalsCollapsed = false;
        if (!radGrid.childElementCount) renderRadicalTiles();
        animateGridWrap(radWrap, true);
        radChev.classList.add('open');
      } else {
        radicalsCollapsed = true;
        animateGridWrap(radWrap, false);
        radChev.classList.remove('open');
      }
    });

    if (!radClosed) renderRadicalTiles();
  }

  if (state.COMPONENTS?.length) {
    let sortedComponents = [...state.COMPONENTS];
    if (q) {
      const exact    = q.startsWith('"') && q.endsWith('"') && q.length > 2;
      const term     = exact ? q.slice(1, -1) : q;
      const normTerm = normalizePinyin(term).replace(/\s+/g, '');
      sortedComponents = sortedComponents.filter(c => {
        const normPinyin = normalizePinyin(c.pinyin ?? '').replace(/\s+/g, '');
        if (exact) return c.component === term || normPinyin === normTerm;
        return c.component.includes(term) || normPinyin.includes(normTerm);
      });
    }

    const compDiv = document.createElement('div');
    compDiv.className = 'hsk-group';
    compDiv.innerHTML = `
      <div class="hsk-group-header">
        <div class="hsk-group-label">
          <span class="badge component">${t('badge.components')}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--faint);flex-shrink:0"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          <span class="count">${q ? `${sortedComponents.length} / ${state.COMPONENTS.length}` : `${state.COMPONENTS.length}`} ${t('count.components')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <svg class="chevron ${compClosed ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="char-grid-wrap ${compClosed ? 'collapsed' : ''}"><div class="char-grid"></div></div>
    `;
    container.appendChild(compDiv);

    const compHeader = compDiv.querySelector('.hsk-group-header');
    const compWrap   = compDiv.querySelector('.char-grid-wrap');
    const compGrid   = compDiv.querySelector('.char-grid');
    const compChev   = compDiv.querySelector('.chevron');
    if (activeComponent) compGrid.classList.add('component-filtered');

    // Components have no POS, so the 'pos' sort falls back to alphabetical (pinyin).
    if (state.gridSort === 'pinyin' || state.gridSort === 'pos') sortedComponents.sort((a, b) => a.pinyin.localeCompare(b.pinyin));
    else if (state.gridSort === 'productive') sortedComponents.sort((a, b) => (Number(b.productive) || 0) - (Number(a.productive) || 0));
    else if (state.gridSort === 'frequency')  sortedComponents.sort((a, b) => (Number(b.frequency)  || 0) - (Number(a.frequency)  || 0));
    else if (state.gridSort === 'stroke')     sortedComponents.sort((a, b) => (Number(a.stroke)      || 0) - (Number(b.stroke)      || 0));
    else                                      sortedComponents.sort((a, b) => Number(a.id) - Number(b.id));

    // Components present in component_char (i.e. used by at least one character).
    const usedComponents = new Set(Object.keys(state.charsByComponent));
    function renderComponentTiles() {
      let lastCompLabel = null;
      const showCompLabels = !activeComponent && !q;
      sortedComponents.forEach((comp, index) => {
        const lbl = showCompLabels ? gridGroupLabel(comp, index, sortedComponents.length) : null;
        if (lbl !== null && lbl !== lastCompLabel) {
          lastCompLabel = lbl;
          const sep = document.createElement('div');
          sep.className = 'char-grid-label';
          sep.textContent = lbl;
          compGrid.appendChild(sep);
        }
        const tile = document.createElement('button');
        // Empty = this component's id never appears in component_char.
        const isEmpty = !usedComponents.has(String(comp.id));
        tile.className = 'char-tile component-tile' + (comp.id === activeComponent ? ' active' : '') + (isEmpty ? ' empty' : '');
        tile.title = `${comp.meaning} · ${comp.stroke} stroke${comp.stroke === 1 || comp.stroke === '1' ? '' : 's'}`;
        tile.setAttribute('aria-label', `${comp.component}, ${comp.pinyin}, ${comp.meaning}`);
        tile.innerHTML = `<div class="tc">${comp.component}</div><div class="tp">${comp.pinyin}</div>`;
        let compPressTimer = null;
        tile.addEventListener('pointerdown', e => {
          e.stopPropagation();
          compPressTimer = setTimeout(() => {
            compPressTimer = null;
            activeComponent = activeComponent === comp.id ? null : comp.id;
            activeRadical = null;
            componentsCollapsed = false;   // keep the Components grid open after the search bar closes
            closeSearchBar();
            renderGroups();
            if (navigator.vibrate) navigator.vibrate(30);
          }, 450);
        });
        tile.addEventListener('pointerup', () => {
          if (compPressTimer) { clearTimeout(compPressTimer); compPressTimer = null; openComponentModal(comp); }
        });
        tile.addEventListener('pointercancel', () => { if (compPressTimer) { clearTimeout(compPressTimer); compPressTimer = null; } });
        tile.addEventListener('pointermove', e => { if (compPressTimer && (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6)) { clearTimeout(compPressTimer); compPressTimer = null; } });
        tile.addEventListener('contextmenu', e => e.preventDefault());
        compGrid.appendChild(tile);
      });
    }

    compHeader.addEventListener('click', () => {
      if (componentsCollapsed) {
        componentsCollapsed = false;
        if (!compGrid.childElementCount) renderComponentTiles();
        animateGridWrap(compWrap, true);
        compChev.classList.add('open');
      } else {
        componentsCollapsed = true;
        animateGridWrap(compWrap, false);
        compChev.classList.remove('open');
      }
    });

    if (!compClosed) renderComponentTiles();
  }

  if (state.WORDS?.length && state.groupsContent === 'words') sectionTitle(t('groups.words'), t('groups.markHint'),
    `<div class="groups-legend">
       <span class="groups-legend-item"><span class="groups-legend-dot known-dot"></span>${t('stat.known')}</span>
       <span class="groups-legend-item"><span class="groups-legend-dot review-dot"></span>${t('stat.review')}</span>
     </div>`);

  const wordGroupEls = {};
  if (state.groupsContent === 'words') levels.forEach(hsk => {
    let wgroup = state.WORDS.filter(w => w.hsk === hsk);
    if (!wgroup.length) return;
    // Locked levels (free plan) always render — shown collapsed with a "Pro"
    // badge — so users can see what's available. Only hide available levels the
    // user has actively deselected in the filters.
    if (!state.activeHskLevels.has(hsk) && isAvailable(hsk)) return;
    if (q) {
      const exact    = q.startsWith('"') && q.endsWith('"') && q.length > 2;
      const term     = exact ? q.slice(1, -1) : q;
      const normTerm = normalizePinyin(term).replace(/\s+/g, '');
      wgroup = wgroup.filter(w => {
        const normPinyin = normalizePinyin(w.pinyin ?? '').replace(/\s+/g, '');
        if (exact) return w.word === term || normPinyin === normTerm;
        return w.word.includes(term) || normPinyin.includes(normTerm);
      });
    }
    if (activeRadical) {
      const radChars = new Set(state.CHARACTERS.filter(c => c.radical === activeRadical).map(c => c.char));
      wgroup = wgroup.filter(w => [...w.word].some(ch => radChars.has(ch)));
    }
    if (activeComponent) {
      const compSet = state.charsByComponent[activeComponent];
      if (!compSet) { wgroup = []; }
      else {
        const compChars = new Set(state.CHARACTERS.filter(c => compSet.has(c.id)).map(c => c.char));
        wgroup = wgroup.filter(w => [...w.word].some(ch => compChars.has(ch)));
      }
    }
    if (!wgroup.length) return;
    if      (state.gridSort === 'pinyin')     wgroup = [...wgroup].sort((a, b) => (a.pinyin ?? '').localeCompare(b.pinyin ?? ''));
    else if (state.gridSort === 'productive') wgroup = [...wgroup].sort((a, b) => (a.productive ?? 0) - (b.productive ?? 0));
    else if (state.gridSort === 'frequency')  wgroup = [...wgroup].sort((a, b) => (b.frequency  ?? 0) - (a.frequency  ?? 0));
    else if (state.gridSort === 'stroke')     wgroup = [...wgroup].sort((a, b) => (a.stroke      ?? 0) - (b.stroke      ?? 0));
    else if (state.gridSort === 'pos') {
      // Categories ordered by size (most words first); words within a category alphabetical (pinyin).
      const posDesc = w => state.POS_TAGS?.[w.pos] ?? '';
      const counts = new Map();
      wgroup.forEach(w => { const d = posDesc(w); counts.set(d, (counts.get(d) || 0) + 1); });
      wgroup = [...wgroup].sort((a, b) => {
        const da = posDesc(a), db = posDesc(b);
        if (da !== db) return (counts.get(db) || 0) - (counts.get(da) || 0) || da.localeCompare(db);
        return (a.pinyin ?? '').localeCompare(b.pinyin ?? '');
      });
    }
    else                                      wgroup = [...wgroup].sort((a, b) => a.id - b.id);

    // Tiles shown respect the status filter; counts/progress stay on the full level.
    const wgroupIndex = new Map(wgroup.map((w, i) => [w.word, i]));
    const wtiles = wgroup.filter(w => passesStatus(w.word));
    if (!wtiles.length) return;

    const colors    = { 1: 'hsk-1', 2: 'hsk-2', 3: 'hsk-3', 4: 'hsk-4', 5: 'hsk-5', 6: 'hsk-6', 7: 'hsk-7' };
    const fillClass = { 1: 'hsk-1-fill', 2: 'hsk-2-fill', 3: 'hsk-3-fill', 4: 'hsk-4-fill', 5: 'hsk-5-fill', 6: 'hsk-6-fill', 7: 'hsk-7-fill' };
    const isLocked    = state.userPlan === 'free' && !isAvailable(hsk);
    const isWCollapsed = (q || activeRadical || activeComponent) ? false : collapsedWordGroups.has(hsk);
    const wKnownCount = wgroup.filter(w => state.known.has(w.word)).length;
    const wPct = wgroup.length ? Math.round(wKnownCount / wgroup.length * 100) : 0;

    const wdiv = document.createElement('div');
    wdiv.className = 'hsk-group';
    wdiv.innerHTML = `
      <div class="hsk-group-header" ${isLocked ? 'style="opacity:.5;pointer-events:none"' : ''}>
        <div class="hsk-group-label">
          <span class="badge ${colors[hsk]}">${hskLabel(hsk)}</span>
          ${isLocked
            ? `<span style="font-size:.6rem;color:var(--faint);display:flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>${state.supaUser ? 'Pro' : t('badge.signUp')}</span>`
            : `<span class="count">${wKnownCount}/${wgroup.length} ${t('msg.known')}</span>`
          }
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="hsk-prog-bar"><div class="hsk-prog-fill ${fillClass[hsk]}" style="width:${wPct}%"></div></div>
          <svg class="chevron ${isWCollapsed ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="hsk-full-bar"><div class="hsk-full-bar-fill ${fillClass[hsk]}" style="width:${wPct}%"></div></div>
      <div class="char-grid-wrap ${isWCollapsed ? 'collapsed' : ''}"><div class="char-grid" id="wgrid-${hsk}"></div></div>
    `;
    container.appendChild(wdiv);

    const wheader = wdiv.querySelector('.hsk-group-header');
    const wwrap   = wdiv.querySelector('.char-grid-wrap');
    const wgrid   = wdiv.querySelector(`#wgrid-${hsk}`);
    const wchev   = wdiv.querySelector('.chevron');
    wordGroupEls[hsk] = { wwrap, wchev, wgrid };

    // One delegated listener set on the grid — no per-tile listeners
    const wordMap = new Map(wtiles.map(w => [w.word, w]));
    let wPressTimer = null, wPressTile = null, wPressWord = null;
    wgrid.addEventListener('pointerdown', e => {
      const tile = e.target.closest('.char-tile');
      if (!tile) return;
      e.stopPropagation();
      wPressTile = tile; wPressWord = wordMap.get(tile.dataset.word);
      wPressTimer = setTimeout(() => {
        wPressTimer = null;
        const word = wPressWord, t = wPressTile;
        if (!word || !t) return;
        if (state.unknown.has(word.word)) {
          state.unknown.delete(word.word); t.classList.remove('repaso');
          if (!state.deck.find(c => c.char === word.word)) state.deck.push({ ...word, char: word.word, isWord: true });
        } else if (state.known.has(word.word)) {
          state.known.delete(word.word); state.unknown.add(word.word);
          t.classList.remove('known'); t.classList.add('repaso');
          if (!state.deck.find(c => c.char === word.word)) state.deck.push({ ...word, char: word.word, isWord: true });
        } else {
          state.known.add(word.word); t.classList.add('known');
          state.deck = state.deck.filter(c => c.char !== word.word);
        }
        saveState();
        const newKnownCount = wgroup.filter(w => state.known.has(w.word)).length;
        const newPct = wgroup.length ? Math.round(newKnownCount / wgroup.length * 100) : 0;
        wdiv.querySelector('.count').textContent = `${newKnownCount}/${wgroup.length} known`;
        wdiv.querySelector('.hsk-prog-fill').style.width = newPct + '%';
        wdiv.querySelector('.hsk-full-bar-fill').style.width = newPct + '%';
        const _f = state.WORDS.filter(w => state.activeHskLevels.has(w.hsk) && isAvailable(w.hsk));
        const _k = _f.filter(w => state.known.has(w.word)).length;
        const _r = _f.filter(w => state.unknown.has(w.word)).length;
        document.getElementById('vKnown').textContent = _k;
        document.getElementById('vRepaso').textContent = _r;
        document.getElementById('vRest').textContent = _f.length - _k - _r;
        updateDeckProgress();
        const pKnown = document.getElementById('p-known');
        if (pKnown) {
          const total = _f.length;
          const pct2 = total ? Math.min(100, Math.round(_k / total * 100)) : 0;
          pKnown.textContent = _k;
          document.getElementById('p-review').textContent = _r;
          document.getElementById('p-left').textContent = total - _k - _r;
          document.getElementById('p-pct').textContent = pct2 + '%';
          document.getElementById('p-bar').style.width = pct2 + '%';
        }
        if (navigator.vibrate) navigator.vibrate(30);
      }, 450);
    });
    wgrid.addEventListener('pointerup', e => {
      if (!wPressTimer) return;
      clearTimeout(wPressTimer); wPressTimer = null;
      if (e.target.closest('.char-tile') && wPressWord) openWordModal(wPressWord);
    });
    wgrid.addEventListener('pointercancel', () => { if (wPressTimer) { clearTimeout(wPressTimer); wPressTimer = null; } });
    wgrid.addEventListener('pointermove', e => { if (wPressTimer && (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6)) { clearTimeout(wPressTimer); wPressTimer = null; } });
    wgrid.addEventListener('contextmenu', e => e.preventDefault());

    function renderWordTiles() {
      if (isLocked) {
        wgrid.innerHTML = `
          <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 0">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="color:var(--faint)"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <p style="font-size:.75rem;color:var(--faint);text-align:center;margin:0">${hskLabel(hsk)} ${t('msg.availablePro')}</p>
          </div>`;
        return;
      }
      // Ordered cell list: section labels (when the sort groups them) + tiles.
      // Each label carries the tile count of its group, shown in parentheses.
      const wLabels = wtiles.map(word => gridGroupLabel(word, wgroupIndex.get(word.word) ?? 0, wgroup.length));
      const wLabelCounts = new Map();
      for (const l of wLabels) if (l !== null) wLabelCounts.set(l, (wLabelCounts.get(l) || 0) + 1);
      const cells = [];
      let lastLbl = null;
      for (let i = 0; i < wtiles.length; i++) {
        const lbl = wLabels[i];
        if (lbl !== null && lbl !== lastLbl) { lastLbl = lbl; cells.push({ label: lbl, count: wLabelCounts.get(lbl) }); }
        cells.push({ word: wtiles[i] });
      }
      const renderCell = (cell) => {
        if (cell.label !== undefined) {
          const sep = document.createElement('div');
          sep.className = 'char-grid-label';
          sep.textContent = state.gridSort === 'pos' ? `${cell.label} (${cell.count})` : cell.label;
          return sep;
        }
        const word = cell.word;
        const tile = wordTileProto.cloneNode(true);
        const len = [...(word.word || '')].length;
        const fs  = len <= 1 ? '1.4rem' : len === 2 ? '1.05rem' : len === 3 ? '.82rem' : '.6rem';
        const pfs = len >= 4 ? '.5rem' : '.6rem';
        if (state.known.has(word.word)) tile.classList.add('known');
        else if (state.unknown.has(word.word)) tile.classList.add('repaso');
        tile.dataset.word = word.word;
        tile.setAttribute('aria-label', `${word.word}, ${word.pinyin ?? ''}, ${word.meaning ?? ''}`);
        const tc = tile.firstChild, tp = tile.lastChild;
        tc.textContent = word.word;          tc.style.fontSize = fs;
        tp.textContent = word.pinyin ?? '';  tp.style.fontSize = pfs;
        return tile;
      };

      if (wgrid._vgrid) { wgrid._vgrid.destroy(); wgrid._vgrid = null; }
      if (cells.length >= VIRTUALIZE_THRESHOLD) {
        wgrid._vgrid = mountVirtualGrid({ scrollEl, gridEl: wgrid, cells, renderCell });
      } else {
        const frag = document.createDocumentFragment();
        for (const cell of cells) frag.appendChild(renderCell(cell));
        wgrid.replaceChildren(frag);
      }
    }

    wheader.addEventListener('click', () => {
      // Decide from the real open/closed state (see the char handler): a filter
      // force-opens grids without updating the set, so relying on it needed two taps.
      if (wwrap.classList.contains('collapsed')) {
        levels.forEach(otherHsk => {
          if (otherHsk !== hsk && !collapsedWordGroups.has(otherHsk) && wordGroupEls[otherHsk]) {
            collapsedWordGroups.add(otherHsk);
            const el = wordGroupEls[otherHsk];
            clearGrid(el.wgrid);
            el.wwrap.style.transition = 'none';
            el.wwrap.classList.add('collapsed');
            el.wchev.classList.remove('open');
          }
        });
        void scrollEl.offsetHeight;
        requestAnimationFrame(() => {
          levels.forEach(otherHsk => {
            if (wordGroupEls[otherHsk]) wordGroupEls[otherHsk].wwrap.style.transition = '';
          });
        });
        collapsedWordGroups.delete(hsk);
        if (!wgrid.childElementCount) renderWordTiles();
        animateGridWrap(wwrap, true);
        wchev.classList.add('open');
      } else {
        collapsedWordGroups.add(hsk);
        clearGrid(wgrid);
        animateGridWrap(wwrap, false);
        wchev.classList.remove('open');
      }
    });

    if (!isWCollapsed) renderWordTiles();
  });

  if (state.groupsContent === 'characters' && state.CHARACTERS?.length) sectionTitle(t('groups.characters'), t('groups.markHint'),
    `<div class="groups-legend">
       <span class="groups-legend-item"><span class="groups-legend-dot known-dot"></span>${t('stat.known')}</span>
       <span class="groups-legend-item"><span class="groups-legend-dot review-dot"></span>${t('stat.review')}</span>
     </div>`);

  const charGroupEls = {};
  if (state.groupsContent === 'characters') levels.forEach(hsk => {
    let group = state.CHARACTERS.filter(c => c.hsk === hsk);
    if (!group.length) return;
    // Locked levels (free plan) always render — shown collapsed with a "Pro"
    // badge — so users can see what's available. Only hide available levels the
    // user has actively deselected in the filters.
    if (!state.activeHskLevels.has(hsk) && isAvailable(hsk)) return;
    if (q) {
      const exact = q.startsWith('"') && q.endsWith('"') && q.length > 2;
      const term = exact ? q.slice(1, -1) : q;
      group = group.filter(c =>
        c.char.includes(term) ||
        (exact
          ? normalizePinyin(c.pinyin) === normalizePinyin(term)
          : normalizePinyin(c.pinyin).includes(normalizePinyin(term))
        )
      );
    }
    if (!group.length) return;
    if (activeRadical) group = group.filter(c => c.radical === activeRadical);
    if (activeComponent) {
      const compSet = state.charsByComponent[activeComponent];
      group = compSet ? group.filter(c => compSet.has(c.id)) : [];
    }
    if (!group.length) return;
    if (state.gridSort === 'pinyin')      group = [...group].sort((a, b) => a.pinyin.localeCompare(b.pinyin));
    else if (state.gridSort === 'productive') group = [...group].sort((a, b) => (a.productive ?? 0) - (b.productive ?? 0));
    else if (state.gridSort === 'frequency')  group = [...group].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
    else if (state.gridSort === 'stroke')     group = [...group].sort((a, b) => (a.stroke ?? 0) - (b.stroke ?? 0));
    else if (state.gridSort === 'pos') {
      // Categories ordered by size (most chars first); chars within a category alphabetical (pinyin).
      const posDesc = c => state.POS_TAGS?.[c.pos] ?? '';
      const counts = new Map();
      group.forEach(c => { const d = posDesc(c); counts.set(d, (counts.get(d) || 0) + 1); });
      group = [...group].sort((a, b) => {
        const da = posDesc(a), db = posDesc(b);
        if (da !== db) return (counts.get(db) || 0) - (counts.get(da) || 0) || da.localeCompare(db);
        return (a.pinyin ?? '').localeCompare(b.pinyin ?? '');
      });
    }
    else group = [...group].sort((a, b) => a.id - b.id);

    // Tiles shown respect the status filter; counts/progress stay on the full level.
    const groupIndex = new Map(group.map((c, i) => [c.char, i]));
    const tiles = group.filter(c => passesStatus(c.char));
    if (!tiles.length) return;

    const knownCount = group.filter(c => state.known.has(c.char)).length;
    const pct = group.length ? Math.round(knownCount / group.length * 100) : 0;
    const colors    = { 1: 'hsk-1', 2: 'hsk-2', 3: 'hsk-3', 4: 'hsk-4', 5: 'hsk-5', 6: 'hsk-6', 7: 'hsk-7' };
    const fillClass = { 1: 'hsk-1-fill', 2: 'hsk-2-fill', 3: 'hsk-3-fill', 4: 'hsk-4-fill', 5: 'hsk-5-fill', 6: 'hsk-6-fill', 7: 'hsk-7-fill' };
    const isCollapsed = (q || activeRadical || activeComponent) ? false : collapsedGroups.has(hsk);
    const isLocked = state.userPlan === 'free' && !isAvailable(hsk);

    const div = document.createElement('div');
    div.className = 'hsk-group';
    div.innerHTML = `
      <div class="hsk-group-header" ${isLocked ? 'style="opacity:.5;pointer-events:none"' : ''}>
        <div class="hsk-group-label">
          <span class="badge ${colors[hsk]}">${hskLabel(hsk)}</span>
          ${isLocked
            ? `<span style="font-size:.6rem;color:var(--faint);display:flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>${state.supaUser ? 'Pro' : t('badge.signUp')}</span>`
            : `<span class="count">${knownCount}/${group.length} ${t('msg.known')}</span>`
          }
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="hsk-prog-bar"><div class="hsk-prog-fill ${fillClass[hsk]}" style="width:${pct}%"></div></div>
          <svg class="chevron ${isCollapsed ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="hsk-full-bar"><div class="hsk-full-bar-fill ${fillClass[hsk]}" style="width:${pct}%"></div></div>
      <div class="char-grid-wrap ${isCollapsed ? 'collapsed' : ''}"><div class="char-grid" id="grid-${hsk}"></div></div>
    `;
    container.appendChild(div);

    const header = div.querySelector('.hsk-group-header');
    const wrap   = div.querySelector('.char-grid-wrap');
    const grid   = div.querySelector(`#grid-${hsk}`);
    const chev   = div.querySelector('.chevron');
    charGroupEls[hsk] = { wrap, chev, grid };

    // One delegated listener set on the grid — no per-tile listeners
    const cardMap = new Map(tiles.map(c => [c.char, c]));
    let cPressTimer = null, cPressTile = null, cPressCard = null;
    grid.addEventListener('pointerdown', e => {
      const tile = e.target.closest('.char-tile');
      if (!tile) return;
      e.stopPropagation();
      cPressTile = tile; cPressCard = cardMap.get(tile.dataset.char);
      cPressTimer = setTimeout(() => {
        cPressTimer = null;
        const card = cPressCard, t = cPressTile;
        if (!card || !t) return;
        if (state.unknown.has(card.char)) {
          state.unknown.delete(card.char); t.classList.remove('repaso'); state.deck.push(card);
        } else if (state.known.has(card.char)) {
          state.known.delete(card.char); state.unknown.add(card.char);
          t.classList.remove('known'); t.classList.add('repaso');
          if (!state.deck.find(c => c.char === card.char)) state.deck.push(card);
        } else {
          state.known.add(card.char); t.classList.add('known');
          state.deck = state.deck.filter(c => c.char !== card.char);
        }
        saveState();
        const newKnownCount = group.filter(c => state.known.has(c.char)).length;
        const newPct = group.length ? Math.round(newKnownCount / group.length * 100) : 0;
        div.querySelector('.count').textContent = `${newKnownCount}/${group.length} known`;
        div.querySelector('.hsk-prog-fill').style.width = newPct + '%';
        div.querySelector('.hsk-full-bar-fill').style.width = newPct + '%';
        const _f = state.CHARACTERS.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
        const _k = _f.filter(c => state.known.has(c.char)).length;
        const _r = _f.filter(c => state.unknown.has(c.char)).length;
        document.getElementById('vKnown').textContent = _k;
        document.getElementById('vRepaso').textContent = _r;
        document.getElementById('vRest').textContent = _f.length - _k - _r;
        updateDeckProgress();
        if (navigator.vibrate) navigator.vibrate(30);
      }, 450);
    });
    grid.addEventListener('pointerup', e => {
      if (!cPressTimer) return;
      clearTimeout(cPressTimer); cPressTimer = null;
      if (e.target.closest('.char-tile') && cPressCard) openModal(cPressCard);
    });
    grid.addEventListener('pointercancel', () => { if (cPressTimer) { clearTimeout(cPressTimer); cPressTimer = null; } });
    grid.addEventListener('pointermove', e => { if (cPressTimer && (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6)) { clearTimeout(cPressTimer); cPressTimer = null; } });
    grid.addEventListener('contextmenu', e => e.preventDefault());

    function renderTiles() {
      if (isLocked) {
        grid.innerHTML = `
          <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 0">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="color:var(--faint)"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <p style="font-size:.75rem;color:var(--faint);text-align:center;margin:0">${hskLabel(hsk)} ${t('msg.availablePro')}</p>
          </div>`;
        return;
      }
      // Ordered cell list: section labels (when the sort groups them) + tiles.
      // Each label carries the tile count of its group, shown in parentheses.
      const cLabels = tiles.map(card => gridGroupLabel(card, groupIndex.get(card.char) ?? 0, group.length));
      const cLabelCounts = new Map();
      for (const l of cLabels) if (l !== null) cLabelCounts.set(l, (cLabelCounts.get(l) || 0) + 1);
      const cells = [];
      let lastLbl = null;
      for (let i = 0; i < tiles.length; i++) {
        const lbl = cLabels[i];
        if (lbl !== null && lbl !== lastLbl) { lastLbl = lbl; cells.push({ label: lbl, count: cLabelCounts.get(lbl) }); }
        cells.push({ card: tiles[i] });
      }
      const renderCell = (cell) => {
        if (cell.label !== undefined) {
          const sep = document.createElement('div');
          sep.className = 'char-grid-label';
          sep.textContent = state.gridSort === 'pos' ? `${cell.label} (${cell.count})` : cell.label;
          return sep;
        }
        const card = cell.card;
        const tile = charTileProto.cloneNode(true);
        if (state.known.has(card.char)) tile.classList.add('known');
        else if (state.unknown.has(card.char)) tile.classList.add('repaso');
        tile.dataset.char = card.char;
        tile.setAttribute('aria-label', `${card.char}, ${card.pinyin}, ${card.meaning}`);
        tile.firstChild.textContent = card.char;
        tile.lastChild.textContent = card.pinyin;
        return tile;
      };

      if (grid._vgrid) { grid._vgrid.destroy(); grid._vgrid = null; }
      if (cells.length >= VIRTUALIZE_THRESHOLD) {
        // Big level → window it: only a screenful of tiles ever lives in the DOM.
        grid._vgrid = mountVirtualGrid({ scrollEl, gridEl: grid, cells, renderCell });
      } else {
        const frag = document.createDocumentFragment();
        for (const cell of cells) frag.appendChild(renderCell(cell));
        grid.replaceChildren(frag);
      }
    }

    header.addEventListener('click', () => {
      // Use the actual open/closed state of this grid, not the remembered set —
      // a radical/component filter force-opens every grid without updating the set,
      // which otherwise made the first close-click a no-op (needed two taps).
      if (wrap.classList.contains('collapsed')) {
        levels.forEach(otherHsk => {
          if (otherHsk !== hsk && !collapsedGroups.has(otherHsk) && charGroupEls[otherHsk]) {
            collapsedGroups.add(otherHsk);
            const el = charGroupEls[otherHsk];
            clearGrid(el.grid);
            el.wrap.style.transition = 'none';
            el.wrap.classList.add('collapsed');
            el.chev.classList.remove('open');
          }
        });
        void scrollEl.offsetHeight;
        requestAnimationFrame(() => {
          levels.forEach(otherHsk => {
            if (charGroupEls[otherHsk]) charGroupEls[otherHsk].wrap.style.transition = '';
          });
        });
        collapsedGroups.delete(hsk);
        if (!grid.childElementCount) renderTiles();
        animateGridWrap(wrap, true);
        chev.classList.add('open');
      } else {
        collapsedGroups.add(hsk);
        clearGrid(grid);
        animateGridWrap(wrap, false);
        chev.classList.remove('open');
      }
    });

    if (!isCollapsed) renderTiles();
  });

  refreshGroupsScrollbar();
}

/* ── MODAL ── */
const backdrop     = document.getElementById('modal-backdrop');
const modalContent = document.getElementById('modal-content');

/* Navigation stack for drilling word → char → radical/component. Each modal
   receives the trail of entries behind it; the back button pops one level. */
function modalEntryLabel(e) {
  return e.kind === 'word'    ? e.data.word
       : e.kind === 'char'    ? e.data.char
       : e.kind === 'radical' ? e.data.radical
       :                        e.data.component;
}
function openModalEntry(entry, backStack) {
  if (entry.kind === 'word')      return openWordModal(entry.data, backStack);
  if (entry.kind === 'char')      return openModal(entry.data, backStack);
  if (entry.kind === 'radical')   return openRadicalModal(entry.data, backStack);
  if (entry.kind === 'component') return openComponentModal(entry.data, backStack);
}
function modalBackHTML(backStack) {
  if (!backStack?.length) return '';
  const prev = backStack[backStack.length - 1];
  const label = modalEntryLabel(prev);
  // Tint the back button by the destination it returns to: green for a radical,
  // gray for a component, blue for a char (default) — matching the chip colors.
  const kindClass = prev.kind === 'radical' ? ' modal-back-radical'
                  : prev.kind === 'component' ? ' modal-back-component'
                  : prev.kind === 'word' ? ' modal-back-word'
                  : '';
  return `<button type="button" class="modal-back${kindClass}" id="modal-back-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>${label}</span></button>`;
}
function wireModalBack(backStack) {
  if (!backStack?.length) return;
  const btn = modalContent.querySelector('#modal-back-btn');
  btn?.addEventListener('click', () => openModalEntry(backStack[backStack.length - 1], backStack.slice(0, -1)));
}

// The modal header: optional back button (where you came from) on the left, and a
// type badge (where you are now) on the right. The badge color comes from --tc,
// set on #modal-content via data-type by each opener, so it always encodes the
// current entity type: blue=char, purple=word, green=radical, gray=component.
const MODAL_TYPE_LABEL = { char: 'lbl.char', word: 'lbl.word', radical: 'lbl.radical', component: 'lbl.component' };
function modalHeadHTML(kind, backStack, extraHTML = '') {
  return `<div class="modal-head">${modalBackHTML(backStack)}`
    + `<span class="modal-type"><span class="mt-dot"></span>${t(MODAL_TYPE_LABEL[kind] || 'lbl.char')}</span>${extraHTML}</div>`;
}

export function closeResetModal() {
  const rb = document.getElementById('reset-backdrop');
  rb.classList.remove('open');
  rb.addEventListener('transitionend', () => { rb.style.display = 'none'; }, { once: true });
  const rm = document.getElementById('reset-modal');
  rm.style.transition = '';
  rm.style.transform  = '';
}

export async function openModal(card, backStack = []) {
  if (tourSuppressModal) return;   // tour "mark" step: taps must not pop the modal
  await fetchWordsForChar(card);
  const cardWords = (state.wordsByChar[card.char] || []);
  const groupMap = {};
  cardWords.forEach(w => {
    const g = w.hsk ?? 'Other';
    if (!groupMap[g]) groupMap[g] = [];
    groupMap[g].push(w);
  });
  const groupOrder = Object.keys(groupMap).sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a - b;
  });
  const groupsHTML = groupOrder.length === 0
    ? '<div class="word-item" style="color:var(--faint)">No words found</div>'
    : groupOrder.map((g, i) => {
        const label = g === 'Other' ? 'Other' : hskLabel(g);
        const items = groupMap[g]
          .slice()
          .sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0))
          .map(w =>
          `<div class="word-exp" data-word-id="${w.dbId}">
            <div class="word-exp-header" role="button" tabindex="0">
              <div class="word-exp-info">
                <button type="button" class="word-exp-link" data-word-id="${w.dbId}">${w.id}</button>
                <span class="word-pinyin">${w.pinyin}</span>
                <span class="word-meaning">${w.meaning}</span>
              </div>
              <svg class="word-exp-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="phrase-body collapsed"></div>
          </div>`
        ).join('');
        const open = i === 0;
        return `
          <div class="word-group">
            <button class="word-group-header" data-open="${open}">
              <span>${label}</span>
              <span class="word-group-count">${groupMap[g].length}</span>
              <svg class="word-group-chev ${open ? 'open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="word-group-body ${open ? '' : 'collapsed'}" style="display:flex;flex-direction:column;gap:6px;padding:${open ? '8px 10px' : '0 10px'}">${items}</div>
          </div>`;
      }).join('');

  const radInfo = state.RADICALS.find(r => r.radical === card.radical);
  const radicalHTML = card.radical
    ? (radInfo
        ? `<button type="button" class="char-chip char-chip-link char-chip-radical" data-radical="${card.radical}"><span class="cc-glyph">${card.radical}</span>${radInfo.pinyin ? `<span class="cc-py">${radInfo.pinyin}</span>` : ''}</button>`
        : `<span class="char-chip"><span class="cc-glyph">${card.radical}</span></span>`)
    : '<span class="char-chip-empty">—</span>';

  const charComponents = state.COMPONENTS.filter(comp => state.charsByComponent[comp.id]?.has(card.id));
  const componentsHTML = charComponents.length
    ? charComponents.map(c => `<button type="button" class="char-chip char-chip-link char-chip-component" data-comp-id="${c.id}"><span class="cc-glyph">${c.component}</span>${c.pinyin ? `<span class="cc-py">${c.pinyin}</span>` : ''}</button>`).join('')
    : '<span class="char-chip-empty">—</span>';

  modalContent.dataset.type = 'char';
  const backHTML = modalHeadHTML('char', backStack, statusChipHTML(card.char));

  modalContent.innerHTML = `
    ${backHTML}
    <div class="info-row" style="grid-template-columns:0.82fr 0.82fr 1.18fr 1.18fr">
      ${strokeCellHTML(t('lbl.char'), card.char)}
      <div class="info-cell cell-listen"><div class="cell-listen-main"><div class="lbl">${t('lbl.pinyin')}</div><div class="val">${card.pinyin}</div></div><button class="cell-listen-btn" aria-label="Listen to pronunciation">${MODAL_LISTEN_SVG}</button></div>
      <div class="info-cell"><div class="lbl">${t('lbl.radical')}</div><div class="char-chips">${radicalHTML}</div></div>
      <div class="info-cell"><div class="lbl">${t('lbl.level')}</div><div class="val"><span class="hsk-pill hsk-${card.hsk}">${hskLabel(card.hsk)}</span></div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.meaning')}</div><div class="val">${card.meaning}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.components')}</div><div class="char-chips stack">${componentsHTML}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.compoundWords')} (${cardWords.length})</div><div class="words-list" style="margin-top:6px">${groupsHTML}</div></div>
    </div>
  `;

  attachModalListen(card.char);

  wireStrokeOpen(card.char);   // tap the character or the pencil to see stroke order
  wireStatusChip(modalContent, card, card.char);

  wireModalBack(backStack);

  const deeper = [...backStack, { kind: 'char', data: card }];
  modalContent.querySelectorAll('.char-chip-link[data-comp-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const comp = state.COMPONENTS.find(c => c.id === +btn.dataset.compId);
      if (comp) openComponentModal(comp, deeper);
    });
  });

  modalContent.querySelectorAll('.char-chip-link[data-radical]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rad = state.RADICALS.find(r => r.radical === btn.dataset.radical);
      if (rad) openRadicalModal(rad, deeper);
    });
  });

  wireCompoundGroups();

  // Tapping the word glyph drills into that word's own modal (char pushed onto
  // the back stack). Stop propagation so it doesn't also toggle the phrase list.
  modalContent.querySelectorAll('.word-exp-link[data-word-id]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const w = cardWords.find(x => x.dbId === +btn.dataset.wordId);
      if (!w) return;
      const full = state.WORDS?.find(x => x.id === w.dbId);
      const word = full || { word: w.id, id: w.dbId, pinyin: w.pinyin, meaning: w.meaning, meaning_es: w.meaning_es, hsk: w.hsk };
      openWordModal(word, deeper);
    });
  });

  modalContent.querySelectorAll('.word-exp-header').forEach(btn => {
    btn.addEventListener('click', async () => {
      const wrap = btn.parentElement;
      const body = btn.nextElementSibling;
      const chev = btn.querySelector('.word-exp-chev');
      const willOpen = body.classList.contains('collapsed');

      if (willOpen && !body.dataset.loaded) {
        body.dataset.loaded = '1';
        const wordId = +wrap.dataset.wordId;
        await fetchPhrasesForWord(wordId);
        const phrases = state.phrasesByWord[wordId] || [];
        body.innerHTML = phrases.length === 0
          ? '<div class="phrase-item" style="color:var(--faint)">No phrases found</div>'
          : phrases.map(p =>
              `<div class="phrase-item"><span class="wp-hanzi">${p.phrase}</span><span class="wp-pinyin">${p.pinyin ?? ''}</span><span class="wp-meaning">${p.meaning ?? ''}</span></div>`
            ).join('');
      }

      body.classList.toggle('collapsed', !willOpen);
      chev.classList.toggle('open', willOpen);
    });
  });

  openModalSheet();
}

function compoundCharsHTML(chars) {
  if (chars.length === 0)
    return '<span style="color:var(--faint);font-size:.75rem">No characters found</span>';

  const groupMap = {};
  chars.forEach(c => {
    const g = c.hsk ?? 'Other';
    if (!groupMap[g]) groupMap[g] = [];
    groupMap[g].push(c);
  });
  const groupOrder = Object.keys(groupMap).sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a - b;
  });

  return groupOrder.map((g, i) => {
    const label = g === 'Other' ? 'Other' : hskLabel(g);
    const items = groupMap[g]
      .slice()
      .sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0))
      .map(c =>
        `<div style="display:flex;flex-direction:column;gap:2px;padding:7px 9px;background:var(--surf2);border:1px solid var(--bdr);border-radius:9px"><button type="button" class="compound-char" data-char-id="${c.id}">${c.char}</button><span style="font-size:.72rem;color:var(--muted);line-height:1.3;margin-top:2px">${c.pinyin ?? ''}</span><span style="font-size:.72rem;color:var(--faint);line-height:1.3">${c.meaning ?? ''}</span></div>`
      ).join('');
    const open = i === 0;
    return `
      <div class="word-group">
        <button class="word-group-header" data-open="${open}">
          <span>${label}</span>
          <span class="word-group-count">${groupMap[g].length}</span>
          <svg class="word-group-chev ${open ? 'open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="word-group-body ${open ? '' : 'collapsed'}" style="display:flex;flex-direction:column;gap:6px;padding:${open ? '8px 10px' : '0 10px'}">${items}</div>
      </div>`;
  }).join('');
}

// Wire the compound-character tiles (radical / component modals) so tapping one
// drills into that character's modal, with the current modal pushed onto the
// back stack so the back button returns here.
function wireCompoundChars(backStack) {
  modalContent.querySelectorAll('.compound-char[data-char-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = state.charById[+btn.dataset.charId];
      if (card) openModal(card, backStack);
    });
  });
}

function wireCompoundGroups() {
  modalContent.querySelectorAll('.word-group-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const open = btn.dataset.open === 'true';
      const body = btn.nextElementSibling;
      const chev = btn.querySelector('.word-group-chev');
      btn.dataset.open = !open;
      body.classList.toggle('collapsed', open);
      body.style.padding = open ? '0 10px' : '8px 10px';
      chev.classList.toggle('open', !open);
    });
  });
}

// Shared glyph cell: the character opens the stroke-order animation, with a
// pencil pinned to the cell's corner. Used by the char / radical / component /
// word modals. `glyph` may be multi-character (words → one writer per char).
const STROKE_PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
function strokeCellHTML(label, glyph) {
  return `<div class="info-cell char-cell"><div class="lbl">${label}</div>`
    + `<button type="button" class="val char-stroke-btn js-stroke-open" aria-label="${t('stroke.view')}" style="font-family:var(--cjk);font-size:1.6rem">${glyph}</button>`
    + `<button type="button" class="stroke-open-btn js-stroke-open" aria-label="${t('stroke.view')}">${STROKE_PENCIL_SVG}</button></div>`;
}
function wireStrokeOpen(glyph) {
  modalContent.querySelectorAll('.js-stroke-open')
    .forEach(el => el.addEventListener('click', () => openStrokeOrder(glyph)));
}

function openRadicalModal(rad, backStack = []) {
  if (tourSuppressModal) return;   // tour "filter" step: taps must not pop the modal
  const chars = state.CHARACTERS.filter(c => c.radical === rad.radical);
  const charsHTML = compoundCharsHTML(chars);

  modalContent.dataset.type = 'radical';
  const backHTML = modalHeadHTML('radical', backStack);

  modalContent.innerHTML = `
    ${backHTML}
    <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
      ${strokeCellHTML(t('lbl.radical'), rad.radical)}
      <div class="info-cell cell-listen"><div class="cell-listen-main"><div class="lbl">${t('lbl.pinyin')}</div><div class="val">${rad.pinyin}</div></div><button class="cell-listen-btn" aria-label="Listen to pronunciation">${MODAL_LISTEN_SVG}</button></div>
      <div class="info-cell"><div class="lbl">${t('lbl.strokes')}</div><div class="val">${rad.stroke}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.meaning')}</div><div class="val">${rad.meaning}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.compoundChars')} (${chars.length})</div><div class="words-list" style="margin-top:6px">${charsHTML}</div></div>
    </div>
  `;
  attachModalListen(hanziForReading(rad.radical, rad.pinyin));
  wireModalBack(backStack);
  wireCompoundGroups();
  wireCompoundChars([...backStack, { kind: 'radical', data: rad }]);
  wireStrokeOpen(rad.radical);
  openModalSheet();
}

function openComponentModal(comp, backStack = []) {
  if (tourSuppressModal) return;   // tour "filter" step: taps must not pop the modal
  const set = state.charsByComponent[comp.id];
  const chars = set ? state.CHARACTERS.filter(c => set.has(c.id)) : [];
  const charsHTML = compoundCharsHTML(chars);

  const hasPinyin = !!(comp.pinyin && comp.pinyin.trim());

  modalContent.dataset.type = 'component';
  const backHTML = modalHeadHTML('component', backStack);

  modalContent.innerHTML = `
    ${backHTML}
    <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
      ${strokeCellHTML(t('lbl.component'), comp.component)}
      <div class="info-cell${hasPinyin ? ' cell-listen' : ''}">${hasPinyin ? '<div class="cell-listen-main">' : ''}<div class="lbl">${t('lbl.pinyin')}</div><div class="val">${comp.pinyin || '—'}</div>${hasPinyin ? `</div><button class="cell-listen-btn" aria-label="Listen to pronunciation">${MODAL_LISTEN_SVG}</button>` : ''}</div>
      <div class="info-cell"><div class="lbl">${t('lbl.strokes')}</div><div class="val">${comp.stroke}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.meaning')}</div><div class="val">${comp.meaning}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.compoundChars')} (${chars.length})</div><div class="words-list" style="margin-top:6px">${charsHTML}</div></div>
    </div>
  `;
  if (hasPinyin) attachModalListen(hanziForReading(comp.component, comp.pinyin));
  wireModalBack(backStack);
  wireCompoundGroups();
  wireCompoundChars([...backStack, { kind: 'component', data: comp }]);
  wireStrokeOpen(comp.component);
  openModalSheet();
}

// A single header chip that cycles Left → Known → Review on tap. Each state is a
// self-contained SVG (empty circle / green check disc / blue refresh disc); the
// glyph is centred inside its own viewBox, so it never drifts at any screen zoom.
const STATUS_NEXT = { left: 'know', know: 'review', review: 'left' };
// Coordinates use a 0–16 space (== the rendered px size) so the glyph fits even
// if innerHTML drops the viewBox — otherwise a 24-space circle overflows the 16px
// viewport and paints a solid square.
const STATUS_ICON = {
  left:   '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  know:   '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2l2 2 4.3-4.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  review: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M11 6.2a3.4 3.4 0 1 0 .8 2.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M11.7 3.9v2.4h-2.4" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const itemStatus = key => state.known.has(key) ? 'know' : state.unknown.has(key) ? 'review' : 'left';
const statusChipHTML = key => {
  const s = itemStatus(key);
  return `<button type="button" class="modal-status" data-status="${s}" title="${t('status.' + s)}" aria-label="${t('status.' + s)}">${STATUS_ICON[s]}</button>`;
};

// Apply a study status (left / know / review) picked from an item's modal, then
// reflect it everywhere: the study deck, the header/profile counters (stats), and
// the grid (renderGroups). `item` is a word or char row; `key` is its word/char.
function setItemStatus(item, key, status) {
  state.known.delete(key);
  state.unknown.delete(key);
  if (status === 'know')        state.known.add(key);
  else if (status === 'review') state.unknown.add(key);
  const isWord = item.word !== undefined;
  // Known items leave the study deck; left/review items stay queued in it.
  if (status === 'know') {
    state.deck = state.deck.filter(c => c.char !== key);
  } else if (!state.deck.find(c => c.char === key)) {
    state.deck.push(isWord ? { ...item, char: key, isWord: true } : item);
  }
  stats();   // refresh header + profile counters; persists state
  const scrollEl = document.getElementById('groups-scroll');
  const y = scrollEl ? scrollEl.scrollTop : 0;
  renderGroups();   // refresh grid tiles, group counts and progress bars
  if (scrollEl) scrollEl.scrollTop = y;
}

// Wire the modal's status chip so tapping it cycles to the next status.
function wireStatusChip(container, item, key) {
  const btn = container.querySelector('.modal-status');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = STATUS_NEXT[btn.dataset.status] || 'left';
    setItemStatus(item, key, next);
    btn.dataset.status = next;
    btn.title = btn.ariaLabel = t('status.' + next);
    btn.innerHTML = STATUS_ICON[next];
  });
}

export async function openWordModal(word, backStack = []) {
  if (tourSuppressModal) return;   // tour "mark" step: taps must not pop the modal
  const hskColors = { 1: 'hsk-1', 2: 'hsk-2', 3: 'hsk-3', 4: 'hsk-4', 5: 'hsk-5', 6: 'hsk-6', 7: 'hsk-7' };

  const posDesc = state.POS_TAGS?.[word.pos];
  const posHTML = posDesc
    ? `<span class="char-chip"><span class="cc-glyph" style="font-size:.72rem">${posDesc}</span></span>`
    : '<span class="char-chip-empty">—</span>';

  const wordChars = [...(word.word || '')]
    .map(ch => state.CHARACTERS.find(c => c.char === ch))
    .filter(Boolean);
  const charsHTML = wordChars.length
    ? wordChars.map(c =>
        `<button type="button" class="char-chip char-chip-link" data-char="${c.char}"><span class="cc-glyph">${c.char}</span>${c.pinyin ? `<span class="cc-py">${c.pinyin}</span>` : ''}</button>`
      ).join('')
    : '<span class="char-chip-empty">—</span>';

  modalContent.dataset.type = 'word';
  const backHTML = modalHeadHTML('word', backStack, statusChipHTML(word.word));

  modalContent.innerHTML = `
    ${backHTML}
    <div class="info-row" style="grid-template-columns:1fr 1fr">
      ${strokeCellHTML(t('lbl.word'), word.word)}
      <div class="info-cell"><div class="lbl">${t('lbl.level')}</div><div class="val"><span class="hsk-pill ${hskColors[word.hsk] ?? ''}">${word.hsk == null ? 'HSK ?' : hskLabel(word.hsk)}</span></div></div>
      <div class="info-cell cell-listen"><div class="cell-listen-main"><div class="lbl">${t('lbl.pinyin')}</div><div class="val">${word.pinyin ?? '—'}</div></div><button class="cell-listen-btn" aria-label="Listen to pronunciation">${MODAL_LISTEN_SVG}</button></div>
      <div class="info-cell"><div class="lbl">${t('lbl.pos')}</div><div class="char-chips">${posHTML}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.meaning')}</div><div class="val">${word.meaning ?? '—'}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.characters')}</div><div class="char-chips stack">${charsHTML}</div></div>
      <div class="info-cell full"><div class="lbl">${t('lbl.phrases')}</div><div class="word-phrases-list" id="wm-phrases"><span style="color:var(--faint);font-size:.75rem">${t('word.loading')}</span></div></div>
    </div>
  `;
  attachModalListen(word.word);
  wireModalBack(backStack);
  wireStrokeOpen(word.word);
  wireStatusChip(modalContent, word, word.word);

  const deeper = [...backStack, { kind: 'word', data: word }];
  modalContent.querySelectorAll('.char-chip-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch   = btn.dataset.char;
      const card = state.CHARACTERS.find(c => c.char === ch);
      if (card) openModal(card, deeper);
    });
  });
  openModalSheet();

  await fetchPhrasesForWord(word.id);
  const phrasesEl = modalContent.querySelector('#wm-phrases');
  if (!phrasesEl) return;
  const phrases = state.phrasesByWord[word.id] || [];
  phrasesEl.style.display       = 'flex';
  phrasesEl.style.flexDirection = 'column';
  phrasesEl.style.gap           = '6px';
  phrasesEl.innerHTML = phrases.length === 0
    ? '<span style="color:var(--faint);font-size:.75rem">No phrases found</span>'
    : phrases.map(p =>
        `<div style="position:relative;display:flex;flex-direction:column;gap:2px;padding:7px 34px 7px 9px;background:var(--surf2);border:1px solid var(--bdr);border-radius:9px"><span style="font-family:var(--cjk);font-size:.9rem;font-weight:600;color:var(--txt);line-height:1.3">${p.phrase}</span><span style="font-size:.72rem;color:var(--muted);line-height:1.3">${p.pinyin ?? ''}</span><span style="font-size:.72rem;color:var(--faint);line-height:1.3">${p.meaning ?? ''}</span><button class="cell-listen-btn phrase-listen-btn" data-phrase="${p.phrase}" aria-label="Listen to pronunciation">${MODAL_LISTEN_SVG}</button></div>`
      ).join('');

  phrasesEl.querySelectorAll('.phrase-listen-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      speak(btn.dataset.phrase, on => btn.classList.toggle('playing', on));
    });
  });
}

const modalSheet = document.getElementById('modal');
const MODAL_EASE = 'cubic-bezier(0.32,0.72,0,1)';

// Bumped on every open. A close that started before the latest open carries a
// stale generation, so its (possibly delayed) cleanup is ignored — otherwise a
// pending transitionend/timeout from a previous close could tear down a freshly
// reopened modal, making it flash open then closed.
let modalGen = 0;
let modalOpenedAt = 0;

function closeModal() {
  const gen = modalGen;
  modalSheet.style.transition = `transform 300ms ${MODAL_EASE}`;
  backdrop.style.transition   = 'background 300ms ease';
  modalSheet.style.transform  = 'translateY(100%)';
  backdrop.style.background    = 'rgba(0,0,0,0)';
  // transitionend can be missed on Android (interrupted transition, backgrounded
  // tab…), which would leave the blurred backdrop stuck on screen — so guard the
  // cleanup with a timeout fallback. Skip it if a newer open has happened since.
  const cleanup = () => {
    if (gen !== modalGen) return;
    backdrop.classList.remove('open');
    modalSheet.style.transition = ''; modalSheet.style.transform = ''; modalSheet.style.willChange = '';
    backdrop.style.transition   = ''; backdrop.style.background = '';
  };
  modalSheet.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 360);
}

// Reveal the modal sheet. Clears any inline styles left by a previous close or
// swipe-drag before adding `.open` — on Android a missed `transitionend` can leave
// `transform:translateY(100%)` on the sheet, which (after the slide-up animation
// ends) hides it behind the blurred backdrop, looking like a stuck blurry screen.
function openModalSheet() {
  modalGen++;
  modalOpenedAt = Date.now();
  modalSheet.style.transition = '';
  modalSheet.style.transform  = '';
  modalSheet.style.willChange = '';
  backdrop.style.transition   = '';
  backdrop.style.background   = '';
  backdrop.classList.add('open');
}

backdrop.addEventListener('click', e => {
  // Ignore the tap that opened the sheet: on Android the backdrop appears under the
  // finger mid-tap, and the tap's (synthesized) click then lands on the backdrop,
  // which would instantly close the modal it just opened.
  if (Date.now() - modalOpenedAt < 350) return;
  if (e.target === backdrop) closeModal();
});

// Swipe-down-to-close. Only starts when the sheet is scrolled to the very top and
// the finger moves down, so it never steals scrolling of long content. Pointer
// capture + pointercancel keep it reliable on both iOS and Android.
let mDragId = null, mStartY = 0, mDy = 0, mVel = 0, mLastY = 0, mLastT = 0, mCommitted = false, mRaf = null;

function modalSetY(y) {
  modalSheet.style.transform = `translateY(${y}px)`;
  const h = modalSheet.offsetHeight || 1;
  const p = Math.min(Math.max(y / (h * 0.8), 0), 1);
  backdrop.style.background = `rgba(0,0,0,${0.5 * (1 - p * p * (3 - 2 * p))})`;
}

function modalEndDrag(decide) {
  if (mRaf != null) { cancelAnimationFrame(mRaf); mRaf = null; }
  const d = mDy, v = mVel, was = mCommitted;
  mDragId = null; mCommitted = false; mDy = 0; mVel = 0;
  if (!was) return;
  if (decide && (d > 90 || v > 0.5)) {
    modalSheet.style.transition = `transform 300ms ${MODAL_EASE}`;
    backdrop.style.transition   = 'background 300ms ease';
    closeModal();
  } else if (d > 0) {
    modalSheet.style.transition = `transform 300ms ${MODAL_EASE}`;
    backdrop.style.transition   = 'background 300ms ease';
    modalSheet.style.transform  = 'translateY(0)';
    backdrop.style.background    = 'rgba(0,0,0,0.5)';
    modalSheet.addEventListener('transitionend', () => {
      modalSheet.style.transition = ''; modalSheet.style.transform = ''; modalSheet.style.willChange = '';
      backdrop.style.transition = ''; backdrop.style.background = '';
    }, { once: true });
  }
}

modalSheet.addEventListener('pointerdown', e => {
  if (mDragId !== null || modalSheet.scrollTop > 0) return;
  mDragId = e.pointerId; mStartY = mLastY = e.clientY; mLastT = e.timeStamp;
  mDy = 0; mVel = 0; mCommitted = false;
});

modalSheet.addEventListener('pointermove', e => {
  if (e.pointerId !== mDragId) return;
  mDy = e.clientY - mStartY;
  if (!mCommitted) {
    if (mDy > 6 && modalSheet.scrollTop <= 0) {         // downward at top → dismiss
      mCommitted = true;
      modalSheet.setPointerCapture(e.pointerId);
      modalSheet.style.transition = 'none';
      modalSheet.style.willChange = 'transform';
      backdrop.style.transition   = 'none';
    } else if (mDy < 0) { mDragId = null; return; }     // upward → let it scroll
    else return;
  }
  if (mDy < 0) mDy = 0;
  const dt = e.timeStamp - mLastT;
  if (dt > 0) mVel = (e.clientY - mLastY) / dt;
  mLastY = e.clientY; mLastT = e.timeStamp;
  if (e.cancelable) e.preventDefault();
  if (mRaf == null) mRaf = requestAnimationFrame(() => { mRaf = null; modalSetY(mDy); });
});

modalSheet.addEventListener('pointerup',     e => { if (e.pointerId === mDragId) modalEndDrag(true);  });
modalSheet.addEventListener('pointercancel', e => { if (e.pointerId === mDragId) modalEndDrag(false); });

/* ── TABS ── */
const tabCards     = document.getElementById('tab-cards');
const tabGroups    = document.getElementById('tab-groups');
const tabPhrases   = document.getElementById('tab-slang');
const tabTranslate = document.getElementById('tab-translator');
const tabProfile   = document.getElementById('tab-profile');
const scrCards     = document.getElementById('screen-cards');
const scrGroups    = document.getElementById('screen-groups');
const scrPhrases   = document.getElementById('screen-slang');
const scrTranslate = document.getElementById('screen-translator');
const scrProfile   = document.getElementById('screen-profile');

const TAB_ORDER = ['cards', 'groups', 'slang', 'translator', 'profile'];
let activeTab = 'cards';

/* Sliding pill that tracks the active tab. */
const tabPill   = document.querySelector('.tab-pill');
const glassMap  = document.getElementById('liquidGlassMap');
const PILL_R    = 18; // must match .tab-pill border-radius

/* Build a displacement map (RG = edge normal) so the SVG feDisplacementMap
   refracts the backdrop only near the rim — the iOS "liquid glass" lens. */
let _mapW = 0, _mapH = 0;
function buildGlassMap(w, h) {
  if (!glassMap || w < 4 || h < 4) return;
  w = Math.round(w); h = Math.round(h);
  if (w === _mapW && h === _mapH) return;   // size unchanged → reuse
  _mapW = w; _mapH = h;

  const cv  = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d   = img.data;
  const r   = Math.min(PILL_R, h / 2, w / 2);
  const bezel = Math.min(16, h * 0.55);     // thickness of the refractive rim

  // Signed distance to the rounded rectangle (negative = inside).
  const sd = (px, py) => {
    const qx = Math.abs(px) - (w / 2 - r);
    const qy = Math.abs(py) - (h / 2 - r);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x - w / 2 + 0.5;
      const py = y - h / 2 + 0.5;
      const dist = sd(px, py);
      const i = (y * w + x) * 4;
      let R = 128, G = 128;
      if (dist < 0) {
        const t   = Math.max(0, 1 + dist / bezel); // 1 at rim → 0 deep inside
        const amt = Math.pow(t, 1.8);
        // Outward normal from the SDF gradient.
        let nx = sd(px + 1, py) - sd(px - 1, py);
        let ny = sd(px, py + 1) - sd(px, py - 1);
        const len = Math.hypot(nx, ny) || 1;
        nx /= len; ny /= len;
        // Pull the backdrop inward at the edge (magnifying lens look).
        R = 128 - nx * amt * 120;
        G = 128 - ny * amt * 120;
      }
      d[i] = R; d[i + 1] = G; d[i + 2] = 128; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = cv.toDataURL();
  glassMap.setAttribute('href', url);
  glassMap.setAttribute('width', w);
  glassMap.setAttribute('height', h);
}

let lastPillIndex = -1;
let suppressSquish = false;   // skip the squish when settling after a drag
function movePill() {
  if (!tabPill) return;
  const active = document.querySelector('.tab.active');
  if (!active || !active.offsetWidth) return;
  const padX = 10, padY = 4;
  const w = active.offsetWidth - padX * 2;
  const h = active.offsetHeight - padY * 2;
  buildGlassMap(w, h);

  const idx = TAB_ORDER.indexOf(activeTab);
  const dir = (lastPillIndex < 0 || suppressSquish) ? 0 : Math.sign(idx - lastPillIndex);
  suppressSquish = false;
  if (dir !== 0) {
    // Stretch in the travel direction (leading edge leads), like a liquid blob.
    tabPill.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
    tabPill.classList.remove('sliding');
    void tabPill.offsetWidth;            // restart the keyframe
    tabPill.classList.add('sliding');
  }
  lastPillIndex = idx;

  tabPill.style.width     = w + 'px';
  tabPill.style.height    = h + 'px';
  tabPill.style.translate = `${active.offsetLeft + padX}px ${active.offsetTop + padY}px`;
  tabPill.classList.add('ready');
}

export function showTab(tab) {
  activeTab = tab;
  [scrCards, scrGroups, scrPhrases, scrTranslate, scrProfile].forEach(s => s.classList.remove('active'));
  [tabCards, tabGroups, tabPhrases, tabTranslate, tabProfile].forEach(t => t.classList.remove('active'));
  if (tab === 'cards')          { scrCards.classList.add('active');     tabCards.classList.add('active'); }
  else if (tab === 'groups')    { scrGroups.classList.add('active');    tabGroups.classList.add('active'); renderGroups(); maybeShowGroupsCoach(); }
  else if (tab === 'slang')     { scrPhrases.classList.add('active');   tabPhrases.classList.add('active'); renderSlang(); }
  else if (tab === 'translator'){ scrTranslate.classList.add('active'); tabTranslate.classList.add('active'); initTranslator(); }
  else                          { scrProfile.classList.add('active');   tabProfile.classList.add('active'); renderProfile(); }
  movePill();
  refreshGroupsScrollbar();   // shows on Groups, hides itself on every other tab
}

// Used by the Learn Shuazi tour: clear any active filter/search and reveal the
// Radicals grid + HSK 1 group so the "filter" and "tap a character" steps have
// real tiles to spotlight. Safe to call repeatedly.
export function tourPrepareGroups() {
  state.gridSearch   = '';
  activeRadical      = null;
  activeComponent    = null;
  radicalsCollapsed  = false;
  collapsedGroups.delete(1);
  renderGroups();
}

// True when the grid is already fully collapsed and unfiltered — lets the tour
// helpers skip a redundant renderGroups() (avoids a visible "reload" between two
// steps that share the same grid layout).
function gridIsCollapsed() {
  return radicalsCollapsed && componentsCollapsed && !activeRadical && !activeComponent && !state.gridSearch
    && [1, 2, 3, 4, 5, 6, 7].every(h => collapsedGroups.has(h) && collapsedWordGroups.has(h));
}
// True when only HSK 1 is expanded (both modes) and nothing is filtered.
function gridIsHsk1Open() {
  return radicalsCollapsed && componentsCollapsed && !activeRadical && !activeComponent && !state.gridSearch
    && !collapsedGroups.has(1) && !collapsedWordGroups.has(1)
    && [2, 3, 4, 5, 6, 7].every(h => collapsedGroups.has(h) && collapsedWordGroups.has(h));
}

// Used by the tour's Groups intro step: clear filters and collapse every grid
// (Radicals, Components and all HSK groups) so the screen shows its resting
// state. Undoes any expansion a later step's tourPrepareGroups() left behind.
export function tourCollapseGroups() {
  if (gridIsCollapsed()) return;   // already collapsed — don't reload the grid
  state.gridSearch    = '';
  activeRadical       = null;
  activeComponent     = null;
  radicalsCollapsed   = true;
  componentsCollapsed = true;
  [1, 2, 3, 4, 5, 6, 7].forEach(h => { collapsedGroups.add(h); collapsedWordGroups.add(h); });
  renderGroups();
}

// While the tour's "mark a character" step is active, a single tap on a tile
// must not pop the detail modal (it would cover the tour) — only the long-press
// mark gesture is allowed. openModal / openWordModal honour this flag.
let tourSuppressModal = false;
export function setTourSuppressModal(v) { tourSuppressModal = !!v; }

// Used by the tour's "mark a character" step: collapse everything except HSK 1,
// which is opened (in both words and characters modes) so its tiles are visible
// and ready to long-press.
export function tourOpenHsk1() {
  if (gridIsHsk1Open()) return;   // already open on the same character — no reload
  state.gridSearch    = '';
  activeRadical       = null;
  activeComponent     = null;
  radicalsCollapsed   = true;
  componentsCollapsed = true;
  [2, 3, 4, 5, 6, 7].forEach(h => { collapsedGroups.add(h); collapsedWordGroups.add(h); });
  collapsedGroups.delete(1);
  collapsedWordGroups.delete(1);
  renderGroups();
}

// Tour: force the grid sort mode (and its button label), returning the previous
// mode so the tour can restore the user's choice when it ends.
export function tourSetSort(mode) {
  const prev = state.gridSort;
  state.gridSort = mode;
  const el = document.getElementById('sortLabel');
  if (el) el.textContent = sortLabelText(mode);
  renderGroups();
  return prev;
}

// Used by the tour's "filter" step: open the Radicals grid (everything else
// collapsed and unfiltered) so its first tile can be spotlit and long-pressed.
export function tourOpenRadicals() {
  state.gridSearch    = '';
  activeRadical       = null;
  activeComponent     = null;
  radicalsCollapsed   = false;
  componentsCollapsed = true;
  [1, 2, 3, 4, 5, 6, 7].forEach(h => { collapsedGroups.add(h); collapsedWordGroups.add(h); });
  renderGroups();
}
// Position the pill once layout is ready, and keep it aligned on resize.
requestAnimationFrame(movePill);
window.addEventListener('resize', movePill);
window.addEventListener('load', movePill);
tabCards.onclick     = () => showTab('cards');
tabGroups.onclick    = () => showTab('groups');
tabPhrases.onclick   = () => showTab('slang');
tabTranslate.onclick = () => showTab('translator');
tabProfile.onclick   = () => showTab('profile');

/* Deep-link: /?screen=groups|slang|translator|profile opens on that tab
   (used by the landing page mockup previews). */
{
  const scr = new URLSearchParams(window.location.search).get('screen');
  if (['cards', 'groups', 'slang', 'translator', 'profile'].includes(scr)) {
    requestAnimationFrame(() => showTab(scr));
  }
}

/* ── DRAG THE PILL (Instagram-style) ──
   The knob follows the finger across the bar in real time and snaps to the
   nearest tab on release. A plain tap still falls through to the click handler. */
(function () {
  const barEl = document.querySelector('.tabbar');
  if (!barEl || !tabPill) return;
  const tabEls = [tabCards, tabGroups, tabPhrases, tabTranslate, tabProfile];
  const PAD_X = 10, PAD_Y = 4, GROW = 1.18;
  let dragging = false, moved = false, suppressClick = false;
  let startX = 0, startY = 0, pillW = 0, pillTop = 0, minX = 0, maxX = 0;

  const nearestIndex = clientX => {
    let best = 0, bestD = Infinity;
    tabEls.forEach((t, i) => {
      const r = t.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - clientX);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  // Spring loop: pill lerps toward the finger and stretches with its velocity.
  let targetLeft = 0, curLeft = 0, prevLeft = 0, curGrow = 1, raf = 0;
  function tick() {
    curLeft += (targetLeft - curLeft) * 0.4;
    curGrow += (GROW - curGrow) * 0.22;
    const v = curLeft - prevLeft; prevLeft = curLeft;
    const stretch = Math.max(-0.22, Math.min(0.34, v * 0.05));  // speed → shape
    const sx = curGrow * (1 + stretch);
    const sy = curGrow * (1 - stretch * 0.7);
    tabPill.style.translate = `${curLeft}px ${pillTop}px`;
    tabPill.style.scale = `${sx} ${sy}`;
    if (dragging || Math.abs(targetLeft - curLeft) > 0.3) raf = requestAnimationFrame(tick);
    else raf = 0;
  }

  barEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Ignore touches starting in the bottom safe-area (the iOS home-indicator
    // zone). Swiping along the bottom edge to switch apps lives there and would
    // otherwise drag the tab pill / switch tabs.
    const r = barEl.getBoundingClientRect();
    const padB = parseFloat(getComputedStyle(barEl).paddingBottom) || 0;
    if (padB > 0 && e.clientY > r.bottom - padB) return;
    const active = document.querySelector('.tab.active');
    if (!active) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    pillW   = active.offsetWidth - PAD_X * 2;
    pillTop = active.offsetTop + PAD_Y;
    minX = tabEls[0].offsetLeft + PAD_X;
    maxX = tabEls[tabEls.length - 1].offsetLeft + PAD_X;
    curLeft = prevLeft = targetLeft = active.offsetLeft + PAD_X;
  });

  barEl.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved) {
      if (Math.abs(dx) < 4) return;                 // ignore micro-movement
      if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; } // vertical → bail
      moved = true;
      tabPill.classList.remove('sliding');
      tabPill.style.transition = 'none';            // rAF drives it directly
      tabPill.style.transformOrigin = 'center';
      curGrow = 1;                                   // grow in from rest size
      barEl.setPointerCapture?.(e.pointerId);
      if (!raf) raf = requestAnimationFrame(tick);
    }
    const barRect = barEl.getBoundingClientRect();
    targetLeft = Math.max(minX, Math.min(maxX, e.clientX - barRect.left - pillW / 2));
    // Live-highlight the tab under the finger.
    const idx = nearestIndex(e.clientX);
    tabEls.forEach((t, i) => t.classList.toggle('active', i === idx));
  });

  const end = e => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      suppressClick = true;                         // cancel the trailing click
      e.preventDefault?.();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      tabPill.style.transition = '';                // restore CSS easing
      tabPill.style.scale = '';                     // shrink back to rest size
      suppressSquish = true;                        // smooth settle (no extra squish)
      showTab(TAB_ORDER[nearestIndex(e.clientX)]);  // snap to nearest tab
    }
  };
  barEl.addEventListener('pointerup', end);
  barEl.addEventListener('pointercancel', () => {
    dragging = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    tabPill.style.transition = '';
    tabPill.style.scale = '';
    suppressSquish = true;
    movePill();
  });
  // Swallow the synthetic click that follows a drag so it doesn't re-trigger a tab.
  barEl.addEventListener('click', e => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);
})();

/* ── PROFILE ── */
// Circular inline SVG flags for the language toggle (emoji flags don't render on
// Windows/Chrome, so we draw them). Simplified marks — legible at ~18px.
const FLAG_SVG = {
  en: `<svg class="lang-flag" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><defs><clipPath id="fl-en"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#fl-en)"><rect width="24" height="24" fill="#012169"/><path d="M0 0 24 24M24 0 0 24" stroke="#fff" stroke-width="4.8"/><path d="M0 0 24 24M24 0 0 24" stroke="#C8102E" stroke-width="2.4"/><path d="M12 0V24M0 12H24" stroke="#fff" stroke-width="8"/><path d="M12 0V24M0 12H24" stroke="#C8102E" stroke-width="4.8"/></g></svg>`,
  es: `<svg class="lang-flag" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><defs><clipPath id="fl-es"><circle cx="12" cy="12" r="12"/></clipPath></defs><g clip-path="url(#fl-es)"><rect width="24" height="24" fill="#AA151B"/><rect y="6" width="24" height="12" fill="#F1BF00"/></g></svg>`,
};

export function renderProfile() {
  const container = document.getElementById('profile-scroll');
  const levels = [1, 2, 3, 4, 5, 6, 7];

  function computeStats() {
    if (state.groupsContent === 'words') {
      const filtered = state.WORDS.filter(w => state.activeHskLevels.has(w.hsk) && isAvailable(w.hsk));
      const total   = filtered.length;
      const knownN  = filtered.filter(w => state.known.has(w.word)).length;
      const reviewN = filtered.filter(w => state.unknown.has(w.word)).length;
      const leftN   = total - knownN - reviewN;
      const knownCov = state.WORDS.filter(w => state.known.has(w.word)).reduce((s, w) => s + (w.frequency ?? 0), 0);
      const pct      = Math.min(100, Math.round(knownCov * 100));
      return { total, knownN, reviewN, leftN, pct };
    }
    const filtered = state.CHARACTERS.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
    const total    = filtered.length;
    const knownN   = filtered.filter(c => state.known.has(c.char)).length;
    const reviewN  = filtered.filter(c => state.unknown.has(c.char)).length;
    const leftN    = total - knownN - reviewN;
    const knownCov = state.CHARACTERS.filter(c => state.known.has(c.char)).reduce((s, c) => s + (c.frequency ?? 0), 0);
    const pct = Math.min(100, Math.round(knownCov * 100));
    return { total, knownN, reviewN, leftN, pct };
  }

  function updateStats() {
    const { knownN, reviewN, leftN, pct } = computeStats();
    container.querySelector('#p-known').textContent  = knownN;
    container.querySelector('#p-review').textContent = reviewN;
    container.querySelector('#p-left').textContent   = leftN;
    container.querySelector('#p-pct').textContent    = pct + '%';
    container.querySelector('#p-bar').style.width    = pct + '%';
    container.querySelector('#p-hint').textContent   = t(state.groupsContent === 'words' ? 'progress.hintWords' : 'progress.hintChars');
  }

  const { knownN, reviewN, leftN, pct } = computeStats();

  const STATUS_CONFIG = [
    { key: 'left',   label: t('status.left'),   cls: 'status-left'   },
    { key: 'know',   label: t('status.know'),   cls: 'status-know'   },
    { key: 'review', label: t('status.review'), cls: 'status-review' },
  ];
  const statusPills = STATUS_CONFIG.map(({ key, label, cls }) => {
    const active = state.activeStatuses.has(key);
    return `<button class="status-filter-pill ${cls} ${active ? 'active' : ''}" data-status="${key}">${label}</button>`;
  }).join('');

  const groupsPills = ['words', 'characters'].map(key => {
    const active = state.groupsContent === key;
    const label  = t(key === 'characters' ? 'groups.characters' : 'groups.words');
    return `<button class="status-filter-pill groups-pill ${active ? 'active' : ''}" data-groups="${key}">${label}</button>`;
  }).join('');

  const filterPills = levels.map(hsk => {
    const group = state.CHARACTERS.filter(c => c.hsk === hsk);
    if (!group.length) return '';
    const locked = state.userPlan === 'free' && !isAvailable(hsk);
    // Locked levels can't be toggled, so always show them as selected (with the
    // lock) — every level is active by default; Pro just unlocks the locked ones.
    const active = state.activeHskLevels.has(hsk) || locked;
    return `<button class="hsk-filter-pill hsk-${hsk} ${active ? 'active' : ''} ${locked ? 'locked' : ''}" data-hsk="${hsk}" ${locked ? 'disabled' : ''} style="${locked ? 'opacity:.35;cursor:not-allowed' : ''}" title="${locked ? t('pro.upgradeTooltip') : ''}">
      ${locked ? '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="margin-right:2px;vertical-align:middle"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : ''}${hskLabel(hsk)}
    </button>`;
  }).join('');

  const accountHTML = state.supaUser
    ? `<div class="profile-section">
        <div class="words-title">${t('settings.account')}</div>
        <div class="info-cell full" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div class="lbl">${t('lbl.signedInAs')}</div>
            <div class="val" style="font-size:.8rem;margin-top:2px">${state.supaUser.email}</div>
          </div>
          <button id="signOutBtn" style="padding:6px 14px;border-radius:999px;background:var(--surf);border:1px solid var(--bdr);color:var(--muted);font-size:.68rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">${t('btn.signOut')}</button>
        </div>
        ${state.userPlan === 'pro' ? `
        <div class="info-cell full" style="display:flex;align-items:center;gap:8px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--green)"><polyline points="20 6 9 17 4 12"/></svg>
          <span style="font-size:.75rem;color:var(--green);font-weight:600">${t('pro.unlockedAll')}</span>
        </div>` : ''}
      </div>`
    : `<div class="profile-section">
        <div class="words-title">${t('settings.account')}</div>
        <div class="info-cell full" style="display:flex;flex-direction:column;gap:10px">
          <button id="signInGoogleBtn" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-radius:10px;background:var(--surf);border:1px solid var(--bdr);color:var(--txt);font-size:.8rem;font-weight:600;cursor:pointer;width:100%;box-sizing:border-box">
            <svg width="15" height="15" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.1-9.9 7.1-17z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6.2 0-11.5-4.2-13.4-9.9l-7.8 6C6.5 42.5 14.6 48 24 48z"/></svg>
            ${t('auth.google')}
          </button>
          <div style="display:flex;align-items:center;gap:8px;color:var(--faint);font-size:.68rem">
            <div style="flex:1;height:1px;background:var(--bdr)"></div>${t('auth.or')}<div style="flex:1;height:1px;background:var(--bdr)"></div>
          </div>
          <input id="authEmail" type="email" placeholder="${t('auth.email')}" style="background:var(--bg);border:1px solid var(--bdr);border-radius:10px;padding:9px 12px;font:inherit;font-size:.8rem;color:var(--txt);outline:none;width:100%;box-sizing:border-box"/>
          <div style="position:relative;width:100%">
            <input id="authPass" type="password" placeholder="${t('auth.password')}" style="background:var(--bg);border:1px solid var(--bdr);border-radius:10px;padding:9px 40px 9px 12px;font:inherit;font-size:.8rem;color:var(--txt);outline:none;width:100%;box-sizing:border-box"/>
            <button id="togglePass" type="button" tabindex="-1" aria-label="Show password" style="position:absolute;top:50%;right:6px;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;background:none;border:none;color:var(--muted);cursor:pointer">
              <svg id="eyeOpen" width="17" height="17" viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0"/><path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8m8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7"/></svg>
              <svg id="eyeOff" width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="m10.79 12.912-1.614-1.615a3.5 3.5 0 0 1-4.474-4.474l-2.06-2.06C.938 6.278 0 8 0 8s3 5.5 8 5.5a7 7 0 0 0 2.79-.588M5.21 3.088A7 7 0 0 1 8 2.5c5 0 8 5.5 8 5.5s-.939 1.721-2.641 3.238l-2.062-2.062a3.5 3.5 0 0 0-4.474-4.474z"/><path d="M5.525 7.646a2.5 2.5 0 0 0 2.829 2.829zm4.95.708-2.829-2.83a2.5 2.5 0 0 1 2.829 2.829zm3.171 6-12-12 .708-.708 12 12z"/></svg>
            </button>
          </div>
          <div id="authError" style="font-size:.68rem;color:#c04050;min-height:.8rem;margin-top:-4px"></div>
          <div style="display:flex;gap:8px">
            <button id="signInBtn" style="flex:1;padding:9px;border-radius:10px;background:var(--surf);border:1px solid var(--bdr);color:var(--txt);font-size:.78rem;font-weight:600;cursor:pointer">${t('btn.signIn')}</button>
            <button id="signUpBtn" style="flex:1;padding:9px;border-radius:10px;background:var(--green-bg);border:1px solid rgba(104,191,138,.25);color:var(--green);font-size:.78rem;font-weight:600;cursor:pointer">${t('btn.register')}</button>
          </div>
          <button id="forgotBtn" type="button" style="align-self:center;background:none;border:none;color:var(--faint);font-size:.68rem;cursor:pointer;text-decoration:underline;padding:2px 4px">${t('auth.forgot')}</button>
        </div>
      </div>`;

  container.innerHTML = `
    <div class="profile-section">
      <div class="words-title">${t('profile.game')}</div>
      <div class="groups-filter-row">${groupsPills}</div>
    </div>

    <div class="profile-section">
      <div class="words-title">${t('profile.progress')}</div>
      <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
        <div class="info-cell" style="text-align:center">
          <div class="lbl">${t('stat.known')}</div>
          <div class="val" style="color:var(--green);font-size:1.5rem" id="p-known">${knownN}</div>
        </div>
        <div class="info-cell" style="text-align:center">
          <div class="lbl">${t('stat.review')}</div>
          <div class="val" style="color:var(--blue);font-size:1.5rem" id="p-review">${reviewN}</div>
        </div>
        <div class="info-cell" style="text-align:center">
          <div class="lbl">${t('stat.left')}</div>
          <div class="val" style="font-size:1.5rem" id="p-left">${leftN}</div>
        </div>
      </div>
      <div class="info-cell full" style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="lbl">${t('lbl.overallProgress')}</div>
          <div class="lbl" id="p-pct">${pct}%</div>
        </div>
        <div class="hsk-full-bar"><div class="hsk-full-bar-fill hsk-2-fill" id="p-bar" style="width:${pct}%"></div></div>
        <p id="p-hint" style="font-size:.66rem;color:var(--faint);line-height:1.5;margin:0;white-space:pre-line">${t(state.groupsContent === 'words' ? 'progress.hintWords' : 'progress.hintChars')}</p>
      </div>
    </div>

    <div class="profile-section">
      <div class="words-title">${t('profile.filters')}</div>
      <div class="hsk-filter-row">${filterPills}</div>
      <p class="filter-hint">${t('filter.hintHsk')}</p>
      <div class="status-filter-row">${statusPills}</div>
      <p class="filter-hint">${t('filter.hintStatus')}</p>
    </div>

    ${state.supaUser && state.userPlan !== 'pro' ? `
    <div class="profile-section">
      <div class="words-title">${t('pro.title')}</div>
      <div class="info-cell full" style="padding:0;overflow:hidden">
        <div style="background:var(--green-bg);padding:10px 18px;border-bottom:1px solid rgba(104,191,138,.18)">
          <div style="font-size:.92rem;font-weight:800;color:var(--green);letter-spacing:-.01em">${t('pro.bubbleTitle')}</div>
          <div style="font-size:.68rem;color:var(--green);opacity:.75;margin-top:3px">${t('msg.unlocksHsk')}</div>
        </div>
        <div style="padding:14px 18px;display:flex;flex-direction:column;gap:14px">
          <p style="font-size:.75rem;color:var(--muted);line-height:1.55;margin:0 0 8px">${t('pro.bubbleDesc')}</p>
          <div style="display:flex;flex-direction:column;gap:4px;font-size:.75rem;color:var(--muted)">
            <div>• ${t('pro.perk1')}</div>
            <div>• ${t('pro.perk2')}</div>
            <div>• ${t('pro.perk3')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:7px">
            <img src="./images/bubbletea-brown.png" alt="" style="height:36px;width:auto;flex-shrink:0"/>
            <span style="font-size:.8rem;font-weight:700;color:var(--muted);flex-shrink:0">×</span>
            <button class="bmc-qty bmc-qty-active" data-qty="1" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--green);background:var(--green-bg);color:var(--green);font-size:.82rem;font-weight:700;cursor:pointer;transition:all .15s;flex-shrink:0">1</button>
            <button class="bmc-qty" data-qty="2" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--bdr);background:var(--surf);color:var(--muted);font-size:.82rem;font-weight:700;cursor:pointer;transition:all .15s;flex-shrink:0">2</button>
            <button class="bmc-qty" data-qty="3" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--bdr);background:var(--surf);color:var(--muted);font-size:.82rem;font-weight:700;cursor:pointer;transition:all .15s;flex-shrink:0">3</button>
            <input id="bubbleQtyCustom" type="number" min="1" max="100" value="1" style="width:52px;height:36px;border-radius:10px;border:1.5px solid var(--bdr);background:var(--surf);color:var(--muted);font-size:.82rem;font-weight:700;text-align:center;padding:0;outline:none;-moz-appearance:textfield;flex-shrink:0"/>
          </div>
          <button id="upgradeBannerBtn" style="padding:13px;border-radius:12px;font-size:.88rem;font-weight:800;cursor:pointer;width:100%;letter-spacing:-.01em">
            <span id="bubbleCTAText">${t('pro.support')} · €2</span>
          </button>
        </div>
      </div>
    </div>` : ''}

    ${accountHTML}
  `;

  if (state.userPlan !== 'pro') {
    let bubbleQty = 1;
    const PRICE = 2;
    const ctaEl       = container.querySelector('#bubbleCTAText');
    const qtyBtns     = container.querySelectorAll('.bmc-qty');
    const customInput = container.querySelector('#bubbleQtyCustom');

    const updateBubbleQty = (qty, fromCustom = false) => {
      bubbleQty = qty;
      const total = qty * PRICE;
      if (ctaEl) ctaEl.textContent = `${t('pro.support')} · €${total}`;
      qtyBtns.forEach(b => {
        const active = !fromCustom && Number(b.dataset.qty) === qty;
        b.style.border     = active ? '1.5px solid var(--green)' : '1.5px solid var(--bdr)';
        b.style.background = active ? 'var(--green-bg)' : 'var(--surf)';
        b.style.color      = active ? 'var(--green)' : 'var(--muted)';
      });
      if (customInput) {
        customInput.style.border     = fromCustom ? '1.5px solid var(--green)' : '1.5px solid var(--bdr)';
        customInput.style.background = fromCustom ? 'var(--green-bg)' : 'var(--surf)';
        customInput.style.color      = fromCustom ? 'var(--green)' : 'var(--muted)';
      }
    };

    qtyBtns.forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (customInput) customInput.value = b.dataset.qty;
      updateBubbleQty(Number(b.dataset.qty), false);
    }));

    customInput?.addEventListener('input', () => {
      let v = parseInt(customInput.value, 10);
      if (isNaN(v)) return;
      if (v > 100) { v = 100; customInput.value = 100; }
      if (v >= 1) updateBubbleQty(v, true);
    });

    container.querySelector('#upgradeBannerBtn')?.addEventListener('click', () => {
      if (!state.supaUser) { container.querySelector('#authEmail')?.focus(); return; }
      gtag('event', 'upgrade_to_pro_click');
      startCheckout(bubbleQty);
    });
  }

  if (state.supaUser) {
    container.querySelector('#signOutBtn').addEventListener('click', async () => {
      await supa.auth.signOut();
    });
  } else {
    container.querySelector('#signInGoogleBtn').addEventListener('click', async () => {
      gtag('event', 'login_google_click');
      await supa.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
    });
    const emailEl = container.querySelector('#authEmail');
    const passEl  = container.querySelector('#authPass');
    const errEl   = container.querySelector('#authError');
    const toggleBtn = container.querySelector('#togglePass');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const show = passEl.type === 'password';
        passEl.type = show ? 'text' : 'password';
        container.querySelector('#eyeOpen').style.display = show ? '' : 'none';
        container.querySelector('#eyeOff').style.display  = show ? 'none' : '';
        toggleBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    }
    container.querySelector('#signInBtn').addEventListener('click', async () => {
      errEl.textContent = ''; errEl.style.color = '#c04050';
      const { error } = await supa.auth.signInWithPassword({ email: emailEl.value.trim(), password: passEl.value });
      if (error) errEl.textContent = error.message;
    });
    container.querySelector('#signUpBtn').addEventListener('click', async () => {
      errEl.textContent = ''; errEl.style.color = '#c04050';
      const { data, error } = await supa.auth.signUp({
        email: emailEl.value.trim(),
        password: passEl.value,
        // Store the UI language in user metadata so the confirmation email
        // template can render in the right language ({{ .Data.lang }}).
        options: { emailRedirectTo: window.location.href, data: { lang: state.lang } }
      });
      if (error) {
        console.error('signUp error:', error);
        errEl.textContent = error.message || t('msg.signUpFailed');
        return;
      }
      // Supabase returns a user with an empty identities array when the email
      // is already registered (to prevent email enumeration) — surface that.
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        errEl.textContent = t('msg.emailRegistered');
        return;
      }
      errEl.style.color = 'var(--green)';
      errEl.textContent = t('msg.checkEmail');
    });
    container.querySelector('#forgotBtn')?.addEventListener('click', async () => {
      errEl.textContent = ''; errEl.style.color = '#c04050';
      const email = emailEl.value.trim();
      if (!email) { errEl.textContent = t('auth.enterEmail'); return; }
      // Look the account up first so we can give a useful message. If the lookup
      // is unavailable (null), fall through and just send the reset email.
      const info = await checkAccount(email);
      if (info && !info.exists) { errEl.textContent = t('auth.noAccount'); return; }
      if (info && info.exists && !info.hasPassword && info.providers?.includes('google')) {
        errEl.textContent = t('auth.useGoogle'); return;
      }
      // Recovery email template points back with type=recovery (see app.js).
      const { error } = await supa.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      if (error) { errEl.textContent = error.message; return; }
      errEl.style.color = 'var(--green)';
      errEl.textContent = t('auth.resetSent');
    });
  }

  const rebuildDeck = () => {
    state.deck = state.groupsContent === 'words' ? buildWordDeck() : buildDeck(state.CHARACTERS);
    render();
    updateStats();
    renderGroups();
  };

  container.querySelectorAll('.hsk-filter-pill:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const hsk = +btn.dataset.hsk;
      if (state.activeHskLevels.has(hsk)) {
        if (state.activeHskLevels.size > 1) { state.activeHskLevels.delete(hsk); btn.classList.remove('active'); }
      } else {
        state.activeHskLevels.add(hsk); btn.classList.add('active');
      }
      saveSettings();
      rebuildDeck();
    });
  });

  container.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.status;
      if (state.activeStatuses.has(key)) {
        if (state.activeStatuses.size > 1) { state.activeStatuses.delete(key); btn.classList.remove('active'); }
      } else {
        state.activeStatuses.add(key); btn.classList.add('active');
      }
      saveSettings();
      rebuildDeck();
    });
  });

  container.querySelectorAll('[data-groups]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.groupsContent === btn.dataset.groups) return;
      state.groupsContent = btn.dataset.groups;
      saveSettings();
      container.querySelectorAll('[data-groups]').forEach(b => b.classList.toggle('active', b.dataset.groups === state.groupsContent));
      state.deck = state.groupsContent === 'words' ? buildWordDeck() : buildDeck(state.CHARACTERS);
      render();
      updateStats();
      renderGroups();
    });
  });

  syncLangBtn();   // keep the header flag/code in sync (e.g. language adopted from account)
}

/* ── SLANG ── */
function shuffleArr(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = 0 | Math.random() * (i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; }

// Scale a phrase title down only if it would overflow its row, keeping the largest
// size (≤ the CSS 2.8em) that still fits on one line.
function fitHanziLine(el) {
  if (!el) return;
  el.style.fontSize = '';                 // back to the CSS default (2.8em)
  const box = el.clientWidth;
  if (box > 0 && el.scrollWidth > box) {
    el.style.fontSize = (2.8 * (box / el.scrollWidth) * 0.98).toFixed(3) + 'em';
  }
}
// One observer refits every visible title on any size change — card insertion (the
// initial observe callback), viewport/orientation, or the app panel resizing the
// deck — so there are no scattered refit calls. It watches each `.phrase-text` box
// (not the title itself), whose size is layout-driven and unaffected by the title's
// font-size, so refitting can never feed back into a resize loop.
const hanziFitRO = new ResizeObserver(entries => {
  for (const e of entries) fitHanziLine(e.target.querySelector('.phrase-hanzi'));
});

function makeSlangCardEl(phrase, isStack) {
  const card = document.createElement('div');
  card.className = 'card phrase-card ' + (isStack ? 'stack-under' : 'top');
  card.innerHTML = `
    <div class="phrase-inner">
      <div class="phrase-text">
        <div class="phrase-hanzi">${phrase.id}</div>
        <div class="phrase-pinyin">${phrase.pinyin}</div>
        <div class="phrase-literal">${phrase.literal}</div>
        <div class="phrase-divider"></div>
        <div class="phrase-meaning">${phrase.meaning}</div>
        ${phrase.origin ? `<div class="phrase-origin">${phrase.origin}</div>` : ''}
      </div>
      ${phrase.image ? `<img src="./images/${phrase.image}" alt="${phrase.id}" class="phrase-img" draggable="false" onerror="this.style.display='none'"/>` : ''}
    </div>
  `;
  hanziFitRO.observe(card.querySelector('.phrase-text'));
  return card;
}

// Text sizing is pure CSS: .phrase-inner is a size container and .phrase-text's
// font-size is a clamp() in container-query (cqh) units — so every card is the same
// size on a given device and scales across devices, with no JS measuring, observers
// or reflows. Long phrases that exceed the box are clipped (graceful fade in CSS).

// Mirrors cards.js render(): a 2-card stack (top + one underneath) styled purely
// via the shared .card.top / .card.stack-under CSS — same look as the main deck.
export function renderSlang() {
  const deckPhrEl = document.getElementById('deck-slang');
  if (!state.slangDeck.length) state.slangDeck = shuffleArr(state.PHRASES);
  // Slang streams in behind the first paint, so the deck can still be empty here
  // (tab opened during boot). Leave it empty — app.js repaints once the rows land.
  if (!state.slangDeck.length) return;
  hanziFitRO.disconnect();   // drop observations on the cards we're about to discard
  deckPhrEl.innerHTML = '';
  if (state.slangDeck.length > 1) deckPhrEl.appendChild(makeSlangCardEl(state.slangDeck[1], true));
  const top = makeSlangCardEl(state.slangDeck[0], false);
  deckPhrEl.appendChild(top);
  attachPhraseSwipe(top, state.slangDeck[0]);
}

// Same swipe physics/animation as the main cards' attachDrag (horizontal only,
// since slang has no known/review classification): same 8px axis lock, 100px
// commit threshold, rotation and opacity falloff, and the shared .fly / .snap
// transition classes. Both directions just advance to the next phrase.
function attachPhraseSwipe(cardEl, phrase) {
  let sx = 0, sy = 0, dx = 0, dy = 0, active = false, axis = null;

  function snap() {
    cardEl.classList.add('snap');
    cardEl.style.transform = ''; cardEl.style.opacity = '';
  }
  function onStart(x, y) {
    sx = x; sy = y; dx = 0; dy = 0; active = true; axis = null;
    cardEl.classList.remove('fly', 'snap');
  }
  function onMove(x, y) {
    if (!active) return;
    dx = x - sx; dy = y - sy;
    if (!axis) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      else return;
    }
    if (axis !== 'x') { cardEl.style.transform = ''; cardEl.style.opacity = ''; return; }
    cardEl.style.transform = `translateX(${dx}px) rotate(${dx * 0.05}deg)`;
    cardEl.style.opacity = String(Math.max(.7, 1 - Math.abs(dx) / 360));
  }
  function advance(dir) {
    const deckPhrEl = document.getElementById('deck-slang');
    // Fly the top card off-screen.
    cardEl.classList.add('fly');
    cardEl.style.transform = `translateX(${dir * 140}%) rotate(${dir * 16}deg)`;
    cardEl.style.opacity = '0';

    state.slangDeck.splice(state.slangDeck.indexOf(phrase), 1);
    if (!state.slangDeck.length) state.slangDeck = shuffleArr(state.PHRASES);

    // Smoothly promote the existing under-card to the top (no rebuild = no flash).
    const under = deckPhrEl.querySelector('.phrase-card.stack-under');
    if (!under) { setTimeout(renderSlang, 210); return; }
    under.classList.add('snap');          // .snap eases the scale/opacity change
    under.classList.remove('stack-under');
    under.classList.add('top');
    attachPhraseSwipe(under, state.slangDeck[0]);

    // Slot a fresh card behind the new top right away (hidden under the opaque
    // top card), so quick consecutive swipes always have one ready to promote.
    if (state.slangDeck.length > 1) {
      deckPhrEl.insertBefore(makeSlangCardEl(state.slangDeck[1], true), deckPhrEl.firstChild);
    }

    setTimeout(() => {
      const pt = cardEl.querySelector('.phrase-text');
      if (pt) hanziFitRO.unobserve(pt);   // stop observing the card we're removing
      cardEl.remove();
    }, 230);
  }
  function onEnd() {
    if (!active) return; active = false;
    if (axis === 'x' && Math.abs(dx) > 100) advance(dx > 0 ? 1 : -1);
    else snap();
  }

  // Expose so the keyboard handler can advance the top card with the arrow keys.
  cardEl.advance = advance;

  cardEl.addEventListener('pointerdown', e => { onStart(e.clientX, e.clientY); cardEl.setPointerCapture(e.pointerId); });
  cardEl.addEventListener('pointermove', e => onMove(e.clientX, e.clientY));
  cardEl.addEventListener('pointerup', onEnd);
  cardEl.addEventListener('pointercancel', () => { active = false; snap(); });
}

/* ── SORT & SEARCH ── */
const SORT_CYCLE  = ['pinyin', 'productive', 'frequency', 'stroke', 'pos'];
export const sortLabelText = mode => t('sort.' + mode);

document.getElementById('sortBtn').onclick = () => {
  state.gridSort = SORT_CYCLE[(SORT_CYCLE.indexOf(state.gridSort) + 1) % SORT_CYCLE.length];
  document.getElementById('sortLabel').textContent = sortLabelText(state.gridSort);
  renderGroups();
};

/* ── PINYIN TOGGLE (eye) ── */
const EYE_SVG     = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const pinyinToggleBtn = document.getElementById('pinyinToggleBtn');
function syncPinyinToggle() {
  pinyinToggleBtn.innerHTML = state.showPinyin ? EYE_SVG : EYE_OFF_SVG;
  pinyinToggleBtn.classList.toggle('active', !state.showPinyin);
}
syncPinyinToggle();
pinyinToggleBtn.onclick = () => {
  state.showPinyin = !state.showPinyin;
  syncPinyinToggle();
  const scrollEl = document.getElementById('groups-scroll');
  const y = scrollEl ? scrollEl.scrollTop : 0;
  renderGroups();      // rebuilds the grids, which resets the scroller to top…
  if (scrollEl) scrollEl.scrollTop = y;   // …so restore the reading position
  saveSettings();
};

const searchBarWrap   = document.getElementById('searchBarWrap');
const searchInput     = document.getElementById('searchInput');
const searchClear     = document.getElementById('searchClear');
const searchToggleBtn = document.getElementById('searchToggleBtn');

searchToggleBtn.addEventListener('click', () => {
  const open = searchBarWrap.classList.toggle('open');
  searchToggleBtn.classList.toggle('active', open);
  document.getElementById('searchHint').style.display = open ? 'block' : 'none';
  if (open) searchInput.focus();
  else { searchInput.value = ''; state.gridSearch = ''; renderGroups(); }
});
// Collapse the search bar (used when a long-press radical/component filter takes over).
function closeSearchBar() {
  if (!searchBarWrap.classList.contains('open')) return;
  searchBarWrap.classList.remove('open');
  searchToggleBtn.classList.remove('active');
  document.getElementById('searchHint').style.display = 'none';
  searchInput.value = '';
  state.gridSearch = '';
}
searchInput.addEventListener('input', () => { state.gridSearch = searchInput.value; renderGroups(); });
searchClear.addEventListener('click', () => { searchInput.value = ''; state.gridSearch = ''; renderGroups(); searchInput.focus(); });

// Pull down from the top of the groups list to clear the active filters
// (radical / component / search) — same gesture as the translator results.
function clearGroupFilters() {
  activeRadical = null;
  activeComponent = null;
  radicalsCollapsed = true;     // collapse both Radicals and Components grids
  componentsCollapsed = true;
  searchBarWrap.classList.remove('open');
  searchToggleBtn.classList.remove('active');
  document.getElementById('searchHint').style.display = 'none';
  searchInput.value = '';
  state.gridSearch = '';
  renderGroups();
}
setupPullRefresh({
  scroll:    document.getElementById('groups-scroll'),
  disc:      document.getElementById('groupsPull'),
  content:   document.getElementById('groups-content'),
  onRefresh: clearGroupFilters,
  exitUp:    true,    // wheel + caption glide up and fade instead of spinning in place
  haptic:    () => navigator.vibrate?.(12),
  // A longer, harder pull than the default so it isn't triggered by accident.
  trigger:   96,
  max:       132,
  damp:      120,
  label:     document.getElementById('groupsPullLabel'),
  pullText:  () => t('filters.pullClear'),
  readyText: () => t('filters.releaseClear'),
});

/* ── THEME ──
   Three states cycling light → medium → dark. 'light' is the iOS-style
   palette, 'medium' the original warm-paper light, 'dark' unchanged. The
   button icon shows the CURRENT theme: sun / half circle / moon. */
const THEME_CYCLE = ['light', 'medium', 'dark'];
const THEME_ICONS = {
  // sun — iOS light
  light:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
  // half-filled circle — medium
  medium: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  // moon — dark
  dark:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
};
const nextTheme = t => THEME_CYCLE[(THEME_CYCLE.indexOf(t) + 1) % THEME_CYCLE.length];

export function setTheme(t) {
  if (!THEME_CYCLE.includes(t)) t = 'light';
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('shuazi-theme', t); } catch (e) {}
  saveSettings();
  const icon = THEME_ICONS[t];
  ['themeBtn', 'themeBtnG', 'themeBtnP', 'themeBtnPh', 'themeBtnT'].forEach(id => {
    document.getElementById(id).innerHTML = icon;
  });
  // No grid rebuild here: every tile colour comes from CSS variables that are
  // redefined per [data-theme], so flipping the attribute above recolours the
  // whole grid instantly. Re-rendering would only throw away the user's scroll
  // position (and needlessly rebuild thousands of tiles).
}

const toggleTheme = () => setTheme(nextTheme(document.documentElement.getAttribute('data-theme')));
['themeBtn', 'themeBtnG', 'themeBtnP', 'themeBtnPh', 'themeBtnT'].forEach(id => {
  document.getElementById(id).onclick = toggleTheme;
});

// Language toggle in the profile header (EN ⇄ ES). Shows the active language's
// flag + code; a tap flips it, re-localizes every loaded row in place, then
// repaints the deck, grid, slang and profile. The deck isn't rebuilt (no
// reshuffle) — applyLanguage() localizes the live cards too.
const profileLangBtn = document.getElementById('profileLangBtn');
const syncLangBtn = () => {
  if (!profileLangBtn) return;
  // Two-sided switch: EN (flag left) | ES (flag right); the active side is filled.
  profileLangBtn.innerHTML =
    `<span class="lang-seg${state.lang === 'en' ? ' active' : ''}" data-lang="en">${FLAG_SVG.en}<span>EN</span></span>` +
    `<span class="lang-seg${state.lang === 'es' ? ' active' : ''}" data-lang="es"><span>ES</span>${FLAG_SVG.es}</span>`;
};
syncLangBtn();
profileLangBtn?.addEventListener('click', () => {
  // Only the active side is visible, so any tap simply flips the language.
  state.lang = state.lang === 'es' ? 'en' : 'es';
  syncLangBtn();
  applyLanguage();
  applyStaticTranslations();
  // The sort label is dynamic (reflects the current sort mode), so set it from state.
  const sortLabelEl = document.getElementById('sortLabel');
  if (sortLabelEl) sortLabelEl.textContent = sortLabelText(state.gridSort);
  saveSettings();
  render();
  renderGroups();
  if (state.PHRASES.length) renderSlang();
  renderProfile();
});

/* ── SETTINGS PANEL ── */
(() => {
  const panel = document.getElementById('settingsPanel');
  const scrim = document.getElementById('settingsScrim');
  if (!panel || !scrim) return;

  const openSettings = () => {
    document.body.classList.add('settings-open');
    panel.setAttribute('aria-hidden', 'false');
  };
  const closeSettings = () => {
    document.body.classList.remove('settings-open');
    panel.setAttribute('aria-hidden', 'true');
  };

  document.getElementById('settingsBtnP')?.addEventListener('click', openSettings);
  scrim.addEventListener('click', closeSettings);
  document.getElementById('settingsPanelClose')?.addEventListener('click', closeSettings);

  document.getElementById('settingsAccountBtn')?.addEventListener('click', () => {
    closeSettings();
    openAccountMenu();
  });

  document.getElementById('settingsLearnBtn')?.addEventListener('click', () => {
    // Let the settings panel finish sliding shut before the tour appears, so the
    // two animations don't overlap and jump. Matches the .root .3s transition.
    closeSettings();
    setTimeout(startTour, 300);
  });

  document.getElementById('settingsInviteBtn')?.addEventListener('click', async () => {
    closeSettings();
    const shareData = {
      title: 'shuazi',
      text: 'Learn Chinese characters with shuazi!',
      url: window.location.origin
    };
    try {
      if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText(shareData.url); alert('Link copied to clipboard!'); }
    } catch (e) { /* user dismissed the share sheet */ }
  });

  document.getElementById('settingsContactBtn')?.addEventListener('click', () => {
    closeSettings();
    window.location.href = 'mailto:contact@shuaziapp.com?subject=shuazi%20contact';
  });

  document.getElementById('settingsTermsBtn')?.addEventListener('click', () => closeSettings());
  document.getElementById('settingsPrivacyBtn')?.addEventListener('click', () => closeSettings());

  // Hanzi Rain effect → clean fullscreen overlay with the matrix.html canvas.
  // No close button: exit via browser back gesture/button, Escape, or swipe-down.
  const matrixOverlay = document.getElementById('matrixOverlay');
  const matrixFrame   = document.getElementById('matrixFrame');
  let matrixOpen = false;

  const openMatrix = () => {
    closeSettings();
    if (!matrixFrame.getAttribute('src')) matrixFrame.setAttribute('src', './汉字雨.html');
    matrixOverlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => matrixOverlay.classList.add('open'));
    matrixOpen = true;
    history.pushState({ matrix: true }, '');
  };
  const closeMatrix = (fromPop) => {
    if (!matrixOpen) return;
    matrixOpen = false;
    matrixOverlay.classList.remove('open');
    matrixOverlay.setAttribute('aria-hidden', 'true');
    // unwind the history entry we pushed, unless this close came from popstate
    if (!fromPop && history.state && history.state.matrix) history.back();
  };

  document.getElementById('settingsMatrixBtn')?.addEventListener('click', openMatrix);

  // back gesture / button
  window.addEventListener('popstate', () => { if (matrixOpen) closeMatrix(true); });
  // Escape on desktop (parent document)
  document.addEventListener('keydown', e => { if (matrixOpen && e.key === 'Escape') closeMatrix(); });
  // messages from inside the iframe (Escape pressed while focused there, or swipe-down)
  window.addEventListener('message', e => { if (e.data === 'closeMatrix') closeMatrix(); });

  // iPhone-style interactive drag: swipe LEFT on profile to reveal settings;
  // swipe RIGHT while open to push it back. Mirrors the translator history gesture.
  const profileScreen = document.getElementById('screen-profile');
  const rootEl = document.querySelector('.root');
  let stStartX = 0, stStartY = 0, stWidth = 280, stActive = false, stLocked = false, stMode = null, stOpened = false;

  const stSetDrag = px => {
    document.body.classList.add('settings-dragging');
    rootEl.style.transform = `translateX(${-px}px)`;
  };
  const stSettle = open => {
    document.body.classList.remove('settings-dragging');
    document.body.classList.toggle('settings-open', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    rootEl.style.transform = '';
  };

  document.addEventListener('touchstart', e => {
    // The tour owns horizontal swipes while it's open — don't reveal Settings.
    if (document.body.classList.contains('tour-active')) { stActive = false; return; }
    // Nor should a swipe reveal Settings while a modal sheet (review, etc.) is open.
    if (document.querySelector('.modal-backdrop.open')) { stActive = false; return; }
    stOpened = document.body.classList.contains('settings-open');
    if (e.touches.length !== 1 || (!stOpened && !profileScreen.classList.contains('active'))) { stActive = false; return; }
    if (e.target.closest('.tabbar')) { stActive = false; return; }
    stStartX = e.touches[0].clientX; stStartY = e.touches[0].clientY;
    stWidth = (panel.offsetWidth || 310) - 30;
    stActive = true; stLocked = false; stMode = null;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!stActive) return;
    const dx = e.touches[0].clientX - stStartX, dy = e.touches[0].clientY - stStartY;
    if (!stLocked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { stActive = false; return; }
      if (stOpened) { stMode = 'close'; }
      else { if (dx >= 0) { stActive = false; return; } stMode = 'open'; }
      stLocked = true;
    }
    const base = stOpened ? stWidth : 0;
    stSetDrag(Math.max(0, Math.min(stWidth, base - dx)));
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!stActive || !stLocked) { stActive = false; return; }
    stActive = false;
    const dx = e.changedTouches[0].clientX - stStartX;
    if (stMode === 'open') stSettle(-dx > stWidth * 0.35);
    else                   stSettle(dx < stWidth * 0.35);
  }, { passive: true });
})();

/* ── REVIEW MODAL (1–5 stars + comment → Supabase `reviews`) ── */
(() => {
  const backdrop  = document.getElementById('review-backdrop');
  const modal     = document.getElementById('review-modal');
  const starsEl   = document.getElementById('reviewStars');
  const commentEl = document.getElementById('reviewComment');
  const msgEl     = document.getElementById('review-msg');
  const submitBtn = document.getElementById('reviewSubmitBtn');
  const cancelBtn = document.getElementById('reviewCancelBtn');
  if (!backdrop) return;

  let rating = 0;
  const stars = [...starsEl.querySelectorAll('.review-star')];
  const syncStars = () => stars.forEach(s => s.classList.toggle('on', +s.dataset.val <= rating));

  // Tap or drag a finger across the stars to set the rating.
  const ratingAtX = x => { let r = 0; for (const s of stars) if (x >= s.getBoundingClientRect().left) r = +s.dataset.val; return r; };
  const setStars  = x => { const v = ratingAtX(x); if (v) { rating = v; syncStars(); msgEl.textContent = ''; } };
  let starsDrag = false;
  starsEl.addEventListener('pointerdown', e => { starsDrag = true; try { starsEl.setPointerCapture(e.pointerId); } catch {} setStars(e.clientX); });
  starsEl.addEventListener('pointermove', e => { if (starsDrag) setStars(e.clientX); });
  const endStars = () => { starsDrag = false; };
  starsEl.addEventListener('pointerup', endStars);
  starsEl.addEventListener('pointercancel', endStars);

  const open = () => {
    rating = 0; syncStars();
    commentEl.value = '';
    msgEl.textContent = ''; msgEl.style.color = '';
    submitBtn.disabled = false; submitBtn.textContent = t('review.submit');
    backdrop.style.display = 'flex';
    requestAnimationFrame(() => backdrop.classList.add('open'));
  };
  const close = () => {
    backdrop.classList.remove('open');
    backdrop.addEventListener('transitionend', () => { backdrop.style.display = 'none'; }, { once: true });
    modal.style.transition = ''; modal.style.transform = '';
  };

  // Open from Settings (close the panel first).
  document.getElementById('settingsReviewBtn')?.addEventListener('click', () => {
    document.body.classList.remove('settings-open');
    document.getElementById('settingsPanel')?.setAttribute('aria-hidden', 'true');
    open();
  });

  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  submitBtn.addEventListener('click', async () => {
    if (!rating) { msgEl.style.color = '#c04050'; msgEl.textContent = t('review.needStars'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = t('review.sending');
    try {
      const { error } = await supa.from('reviews').insert({
        user_id: state.supaUser?.id ?? null,
        email:   state.supaUser?.email ?? null,
        rating,
        comment: commentEl.value.trim() || null,
        lang:    state.lang,
      });
      if (error) throw error;
      msgEl.style.color = 'var(--green)';
      msgEl.textContent = t('review.thanks');
      submitBtn.textContent = t('review.submit');   // don't leave it on "Sending…"
      setTimeout(close, 1300);
    } catch (e) {
      console.error('Review submit failed:', e);
      msgEl.style.color = '#c04050';
      msgEl.textContent = t('review.error');
      submitBtn.disabled = false;
      submitBtn.textContent = t('review.submit');
    }
  });

  // Swipe-down to dismiss (mirrors the reset/delete sheets), ignoring drags that
  // start on the stars, textarea or buttons.
  let sy = 0, dy = 0, dragging = false;
  modal.addEventListener('pointerdown', e => {
    if (e.target.closest('.review-stars, .review-comment, button')) return;
    sy = e.clientY; dy = 0; dragging = true; modal.style.transition = 'none';
  });
  modal.addEventListener('pointermove', e => { if (!dragging) return; dy = e.clientY - sy; if (dy > 0) modal.style.transform = `translateY(${dy}px)`; });
  modal.addEventListener('pointerup', () => {
    if (!dragging) return; dragging = false;
    modal.style.transition = 'transform 300ms ease';
    if (dy > 80) close(); else modal.style.transform = '';
  });
})();

/* ── ACCOUNT PANEL (Reset progress / Delete account) ── */
function openAccountMenu() {
  document.getElementById('deleteAccountBtn').style.display = state.supaUser ? '' : 'none';

  const section = document.getElementById('accountUserSection');
  if (section) {
    if (state.supaUser) {
      section.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 14px 14px;border-bottom:1px solid var(--bdr);margin-bottom:6px">
          <div>
            <div class="lbl">${t('lbl.signedInAs')}</div>
            <div class="val" style="font-size:.78rem;margin-top:2px;word-break:break-all">${state.supaUser.email}</div>
          </div>
          <button id="accountSignOutBtn" style="padding:6px 14px;border-radius:999px;background:var(--surf);border:1px solid var(--bdr);color:var(--muted);font-size:.68rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">${t('btn.signOut')}</button>
        </div>`;
      section.querySelector('#accountSignOutBtn').addEventListener('click', async () => {
        await supa.auth.signOut();
      });
    } else {
      section.innerHTML = '';
    }
  }

  document.body.classList.add('account-open');
  document.getElementById('accountPanel').setAttribute('aria-hidden', 'false');
}

(() => {
  const scrim = document.getElementById('accountScrim');
  if (!scrim) return;

  const closeAccount = () => {
    document.body.classList.remove('account-open');
    document.getElementById('accountPanel').setAttribute('aria-hidden', 'true');
  };

  scrim.addEventListener('click', closeAccount);
  document.getElementById('accountPanelClose')?.addEventListener('click', () => {
    closeAccount();
    document.body.classList.add('settings-open');
    document.getElementById('settingsPanel')?.setAttribute('aria-hidden', 'false');
  });

  // Reset progress → confirm sheet.
  document.getElementById('resetBtn').addEventListener('click', () => {
    closeAccount();
    const filtered = state.CHARACTERS.filter(c => isAvailable(c.hsk));
    const knownN  = filtered.filter(c => state.known.has(c.char)).length;
    const reviewN = filtered.filter(c => state.unknown.has(c.char)).length;
    document.getElementById('reset-stats').innerHTML = `
      <div><div style="font-size:1.3rem;font-weight:700;color:var(--green)">${knownN}</div><div style="font-size:.6rem;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-top:2px">${t('stat.known')}</div></div>
      <div><div style="font-size:1.3rem;font-weight:700;color:var(--blue)">${reviewN}</div><div style="font-size:.6rem;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-top:2px">${t('stat.review')}</div></div>
      <div><div style="font-size:1.3rem;font-weight:700">${knownN + reviewN}</div><div style="font-size:.6rem;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-top:2px">${t('common.total')}</div></div>
    `;
    const rb = document.getElementById('reset-backdrop');
    rb.style.display = 'flex';
    requestAnimationFrame(() => rb.classList.add('open'));
  });

  document.getElementById('resetCancelBtn').onclick  = () => closeResetModal();
  document.getElementById('resetConfirmBtn').onclick = () => {
    state.known.clear(); state.unknown.clear(); state.schedule = {};
    state.deck = buildDeck(state.CHARACTERS);
    render(); saveState();
    closeResetModal();
    setTimeout(() => renderProfile(), 200);
    // Wipe the server rows now (awaited), so the reset survives closing the app
    // before the debounced sync would have fired.
    clearProgressInSupabase().catch(e => console.error('Reset sync failed:', e));
  };
  document.getElementById('reset-backdrop').onclick = e => {
    if (e.target === document.getElementById('reset-backdrop')) closeResetModal();
  };
  const rm = document.getElementById('reset-modal');
  let rsY = 0, rsDy = 0, rsDragging = false;
  rm.addEventListener('pointerdown', e => { rsY = e.clientY; rsDy = 0; rsDragging = true; rm.style.transition = 'none'; });
  rm.addEventListener('pointermove', e => { if (!rsDragging) return; rsDy = e.clientY - rsY; if (rsDy > 0) rm.style.transform = `translateY(${rsDy}px)`; });
  rm.addEventListener('pointerup', () => {
    if (!rsDragging) return; rsDragging = false;
    rm.style.transition = 'transform 300ms ease';
    if (rsDy > 80) closeResetModal(); else rm.style.transform = '';
  });

  // Delete account → confirm sheet; deletion runs server-side.
  const dab = document.getElementById('delacct-backdrop');
  const closeDelacct = () => {
    dab.classList.remove('open');
    dab.addEventListener('transitionend', () => { dab.style.display = 'none'; }, { once: true });
  };
  document.getElementById('deleteAccountBtn').addEventListener('click', () => {
    closeAccount();
    document.getElementById('delacct-error').textContent = '';
    dab.style.display = 'flex';
    requestAnimationFrame(() => dab.classList.add('open'));
  });
  document.getElementById('delacctCancelBtn').onclick = () => closeDelacct();
  dab.onclick = e => { if (e.target === dab) closeDelacct(); };
  document.getElementById('delacctConfirmBtn').onclick = async () => {
    const btn = document.getElementById('delacctConfirmBtn');
    const errEl = document.getElementById('delacct-error');
    btn.disabled = true; btn.textContent = 'Deleting…'; errEl.textContent = '';
    try {
      await deleteAccount();
      state.known.clear(); state.unknown.clear();
      state.deck = buildDeck(state.CHARACTERS);
      render(); saveState();
      closeDelacct();
      setTimeout(() => renderProfile(), 200);
    } catch (e) {
      errEl.textContent = e.message || 'Could not delete account.';
      btn.disabled = false; btn.textContent = 'Yes, delete my account';
    }
  };
})();

/* ── KEYBOARD ── */
document.addEventListener('keydown', e => {
  // Don't hijack keys (space, arrows…) while typing in a text field — e.g. the translator.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // Slang screen: arrow keys (or A/D) flick the top phrase card to the next one.
  if (scrPhrases.classList.contains('active')) {
    const topPhrase = document.getElementById('deck-slang')?.querySelector('.phrase-card.top');
    if (!topPhrase) return;
    if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') topPhrase.advance?.(1);
    else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') topPhrase.advance?.(-1);
    return;
  }
  // Only the cards screen reacts to deck shortcuts.
  if (!scrCards.classList.contains('active')) return;
  const deckEl = document.getElementById('deck');
  const top = deckEl.querySelector('.card.top'); if (!top) return;
  if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') classifyKnown();
  else if (e.key === 'ArrowLeft'  || e.key.toLowerCase() === 'a') classifyLeft();
  else if (e.key === 'ArrowUp'    || e.key.toLowerCase() === 'w') classifyReview();
  else if (e.key === ' ') { e.preventDefault(); top.querySelector('.tz-center')?.click(); }
  else if (e.key === 'i') top.querySelector('.tz-right')?.click();
});
