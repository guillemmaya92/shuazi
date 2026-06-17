import { supa } from './config.js';
import { state } from './state.js';
import { saveState } from './progress.js';
import { startCheckout } from './auth.js';
import { buildDeck, render, classifyKnown, classifyLeft, classifyReview, stats, init, isAvailable, normalizePinyin, fetchWordsForChar } from './cards.js';

/* ── GROUPS ── */
const collapsedGroups = new Set([1, 2, 3, 4, 5, 6]);
let radicalsCollapsed = true;
let activeRadical = null;

export function renderGroups() {
  const container = document.getElementById('groups-scroll');
  const levels = [1, 2, 3, 4, 5, 6];
  const q = state.gridSearch.trim();
  container.innerHTML = '';

  if (state.RADICALS?.length) {
    let sortedRadicals = [...state.RADICALS];
    if (q) {
      const exact = q.startsWith('"') && q.endsWith('"') && q.length > 2;
      const term = exact ? q.slice(1, -1) : q;
      sortedRadicals = sortedRadicals.filter(r =>
        r.radical.includes(term) ||
        (exact
          ? normalizePinyin(r.pinyin) === normalizePinyin(term)
          : normalizePinyin(r.pinyin).includes(normalizePinyin(term)) || r.meaning.toLowerCase().includes(term.toLowerCase())
        )
      );
    }

    const radDiv = document.createElement('div');
    radDiv.className = 'hsk-group';
    radDiv.innerHTML = `
      <div class="hsk-group-header">
        <div class="hsk-group-label">
          <span class="badge radical">Radicals</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--faint);flex-shrink:0"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          <span class="count">${q ? `${sortedRadicals.length} / ${state.RADICALS.length}` : `${state.RADICALS.length}`} radicals</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <svg class="chevron ${(q ? false : radicalsCollapsed) ? '' : 'open'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="char-grid-wrap ${(q ? false : radicalsCollapsed) ? 'collapsed' : ''}"><div class="char-grid"></div></div>
    `;
    container.appendChild(radDiv);

    const radHeader = radDiv.querySelector('.hsk-group-header');
    const radWrap   = radDiv.querySelector('.char-grid-wrap');
    const radGrid   = radDiv.querySelector('.char-grid');
    const radChev   = radDiv.querySelector('.chevron');
    if (activeRadical) radGrid.classList.add('radical-filtered');

    radHeader.addEventListener('click', () => {
      if (radicalsCollapsed) { radicalsCollapsed = false; radWrap.classList.remove('collapsed'); radChev.classList.add('open'); }
      else { radicalsCollapsed = true; radWrap.classList.add('collapsed'); radChev.classList.remove('open'); }
    });

    if (state.gridSort === 'pinyin')          sortedRadicals.sort((a, b) => a.pinyin.localeCompare(b.pinyin));
    else if (state.gridSort === 'productive') sortedRadicals.sort((a, b) => (Number(b.productive) || 0) - (Number(a.productive) || 0));
    else if (state.gridSort === 'coverage')   sortedRadicals.sort((a, b) => (Number(b.coverage)   || 0) - (Number(a.coverage)   || 0));
    else if (state.gridSort === 'stroke')     sortedRadicals.sort((a, b) => (Number(a.stroke)      || 0) - (Number(b.stroke)      || 0));
    else                                      sortedRadicals.sort((a, b) => Number(a.id) - Number(b.id));

    sortedRadicals.forEach(rad => {
      const tile = document.createElement('button');
      tile.className = 'char-tile radical-tile' + (rad.radical === activeRadical ? ' active' : '');
      tile.title = `${rad.meaning} · ${rad.stroke} stroke${rad.stroke === '1' ? '' : 's'}`;
      tile.setAttribute('aria-label', `${rad.radical}, ${rad.pinyin}, ${rad.meaning}`);
      tile.innerHTML = `<div class="tc">${rad.radical}</div><div class="tp">${rad.pinyin}</div>`;
      let radPressTimer = null;
      tile.addEventListener('pointerdown', e => {
        e.stopPropagation();
        radPressTimer = setTimeout(() => {
          radPressTimer = null;
          activeRadical = activeRadical === rad.radical ? null : rad.radical;
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

  levels.forEach(hsk => {
    let group = state.CHARACTERS.filter(c => c.hsk === hsk);
    if (!group.length) return;
    if (!state.activeHskLevels.has(hsk)) return;
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
    if (!group.length) return;
    if (state.gridSort === 'pinyin')      group = [...group].sort((a, b) => a.pinyin.localeCompare(b.pinyin));
    else if (state.gridSort === 'productive') group = [...group].sort((a, b) => (a.productive ?? 0) - (b.productive ?? 0));
    else if (state.gridSort === 'coverage')   group = [...group].sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0));
    else if (state.gridSort === 'stroke')     group = [...group].sort((a, b) => (a.stroke ?? 0) - (b.stroke ?? 0));
    else group = [...group].sort((a, b) => a.id - b.id);

    const knownCount = group.filter(c => state.known.has(c.char)).length;
    const pct = group.length ? Math.round(knownCount / group.length * 100) : 0;
    const colors    = { 1: 'hsk-1', 2: 'hsk-2', 3: 'hsk-3', 4: 'hsk-4', 5: 'hsk-5', 6: 'hsk-6' };
    const fillClass = { 1: 'hsk-1-fill', 2: 'hsk-2-fill', 3: 'hsk-3-fill', 4: 'hsk-4-fill', 5: 'hsk-5-fill', 6: 'hsk-6-fill' };
    const isCollapsed = (q || activeRadical) ? false : collapsedGroups.has(hsk);
    const isLocked = state.userPlan === 'free' && !isAvailable(hsk);

    const div = document.createElement('div');
    div.className = 'hsk-group';
    div.innerHTML = `
      <div class="hsk-group-header" ${isLocked ? 'style="opacity:.5;pointer-events:none"' : ''}>
        <div class="hsk-group-label">
          <span class="badge ${colors[hsk]}">HSK ${hsk}</span>
          ${isLocked
            ? `<span style="font-size:.6rem;color:var(--faint);display:flex;align-items:center;gap:4px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>${state.supaUser ? 'Pro' : 'Sign up'}</span>`
            : `<span class="count">${knownCount}/${group.length} known</span>`
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

    header.addEventListener('click', () => {
      if (collapsedGroups.has(hsk)) { collapsedGroups.delete(hsk); wrap.classList.remove('collapsed'); chev.classList.add('open'); }
      else { collapsedGroups.add(hsk); wrap.classList.add('collapsed'); chev.classList.remove('open'); }
    });

    group.forEach(card => {
      const tile = document.createElement('button');
      const isKnown  = state.known.has(card.char);
      const isRepaso = state.unknown.has(card.char);
      tile.className = 'char-tile' + (isKnown ? ' known' : isRepaso ? ' repaso' : '');
      tile.setAttribute('aria-label', `${card.char}, ${card.pinyin}, ${card.meaning}`);
      tile.innerHTML = `
        <div class="tc">${card.char}</div>
        <div class="tp">${card.pinyin}</div>
        <div class="toggle-btn">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="2,6 5,9 10,3"/>
          </svg>
        </div>`;

      let pressTimer = null;
      function startPress() {
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (state.unknown.has(card.char)) {
            state.unknown.delete(card.char);
            tile.classList.remove('repaso');
            state.deck.push(card);
          } else if (state.known.has(card.char)) {
            state.known.delete(card.char);
            state.unknown.add(card.char);
            tile.classList.remove('known');
            tile.classList.add('repaso');
            if (!state.deck.find(c => c.char === card.char)) state.deck.push(card);
          } else {
            state.known.add(card.char);
            tile.classList.add('known');
            state.deck = state.deck.filter(c => c.char !== card.char);
          }
          saveState();
          const newKnownCount = group.filter(c => state.known.has(c.char)).length;
          const newPct = group.length ? Math.round(newKnownCount / group.length * 100) : 0;
          div.querySelector('.count').textContent = `${newKnownCount}/${group.length} known`;
          div.querySelector('.hsk-prog-fill').style.width = newPct + '%';
          const _f = state.CHARACTERS.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
          const _k = _f.filter(c => state.known.has(c.char)).length;
          const _r = _f.filter(c => state.unknown.has(c.char)).length;
          document.getElementById('vKnown').textContent  = _k;
          document.getElementById('vRepaso').textContent = _r;
          document.getElementById('vRest').textContent   = _f.length - _k - _r;
          if (navigator.vibrate) navigator.vibrate(30);
        }, 450);
      }
      function cancelPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }

      tile.addEventListener('pointerdown',   e => { e.stopPropagation(); startPress(); });
      tile.addEventListener('pointerup',     () => { if (pressTimer) { cancelPress(); openModal(card); } });
      tile.addEventListener('pointercancel', cancelPress);
      tile.addEventListener('pointermove',   e => { if (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6) cancelPress(); });
      tile.addEventListener('contextmenu',   e => e.preventDefault());
      grid.appendChild(tile);
    });

    if (isLocked) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 0">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="color:var(--faint)"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <p style="font-size:.75rem;color:var(--faint);text-align:center;margin:0">HSK ${hsk} is available with shuazi Pro</p>
        </div>`;
    }
  });
}

/* ── MODAL ── */
const backdrop     = document.getElementById('modal-backdrop');
const modalContent = document.getElementById('modal-content');

export function closeResetModal() {
  const rb = document.getElementById('reset-backdrop');
  const rm = document.getElementById('reset-modal');
  rb.style.opacity = '0';
  rm.style.transform = 'translateY(100%)';
  setTimeout(() => { rb.style.display = 'none'; rm.style.transform = ''; }, 300);
}

export async function openModal(card) {
  await fetchWordsForChar(card);
  const cardWords = (state.wordsByChar[card.char] || []);
  const GROUP_LABELS = { 1: 'Common', 2: 'Uncommon', 3: 'Rare' };
  const groupMap = {};
  cardWords.forEach(w => {
    const g = w.group ?? 'Other';
    if (!groupMap[g]) groupMap[g] = [];
    groupMap[g].push(w);
  });
  const groupOrder = Object.keys(groupMap).sort((a, b) => a - b);
  const groupsHTML = groupOrder.length === 0
    ? '<div class="word-item" style="color:var(--faint)">No words found</div>'
    : groupOrder.map((g, i) => {
        const label = GROUP_LABELS[g] ?? g;
        const items = groupMap[g].map(w =>
          `<div class="word-item"><strong>${w.id}</strong><span class="word-pinyin">${w.pinyin}</span><span class="word-meaning">${w.meaning}</span></div>`
        ).join('');
        const open = i === 0;
        return `
          <div class="word-group">
            <button class="word-group-header" data-open="${open}">
              <span>${label}</span>
              <span class="word-group-count">${groupMap[g].length}</span>
              <svg class="word-group-chev ${open ? 'open' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="word-group-body ${open ? '' : 'collapsed'}">${items}</div>
          </div>`;
      }).join('');

  modalContent.innerHTML = `
    <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
      <div class="info-cell"><div class="lbl">Hanzi</div><div class="val" style="font-family:'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif;font-size:1.6rem">${card.char}</div></div>
      <div class="info-cell"><div class="lbl">Pinyin</div><div class="val">${card.pinyin}</div></div>
      <div class="info-cell"><div class="lbl">Level</div><div class="val"><span class="hsk-pill hsk-${card.hsk}">HSK ${card.hsk}</span></div></div>
      <div class="info-cell full"><div class="lbl">Meaning</div><div class="val">${card.meaning}</div></div>
    </div>
    <div class="words-title">Compound words</div>
    <div class="words-list">${groupsHTML}</div>
  `;

  modalContent.querySelectorAll('.word-group-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const open = btn.dataset.open === 'true';
      const body = btn.nextElementSibling;
      const chev = btn.querySelector('.word-group-chev');
      btn.dataset.open = !open;
      body.classList.toggle('collapsed', open);
      chev.classList.toggle('open', !open);
    });
  });

  backdrop.classList.add('open');
}

function openRadicalModal(rad) {
  const chars = state.CHARACTERS.filter(c => c.radical === rad.radical);
  const charsHTML = chars.length === 0
    ? '<div class="word-item" style="color:var(--faint)">No characters found</div>'
    : chars.map(c =>
        `<div class="word-item"><strong style="font-family:'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif;font-size:1.1rem">${c.char}</strong><span class="word-pinyin">${c.pinyin}</span><span class="word-meaning">${c.meaning}</span></div>`
      ).join('');

  modalContent.innerHTML = `
    <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
      <div class="info-cell"><div class="lbl">Hanzi</div><div class="val" style="font-family:'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Microsoft YaHei',sans-serif;font-size:1.6rem">${rad.radical}</div></div>
      <div class="info-cell"><div class="lbl">Pinyin</div><div class="val">${rad.pinyin}</div></div>
      <div class="info-cell"><div class="lbl">Strokes</div><div class="val">${rad.stroke}</div></div>
      <div class="info-cell full"><div class="lbl">Meaning</div><div class="val">${rad.meaning}</div></div>
    </div>
    <div class="words-title">Compound characters <span style="font-size:.65rem;color:var(--faint);font-weight:400">(${chars.length})</span></div>
    <div class="words-list">${charsHTML}</div>
  `;
  backdrop.classList.add('open');
}

backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.classList.remove('open'); });

/* ── TABS ── */
const tabCards   = document.getElementById('tab-cards');
const tabGroups  = document.getElementById('tab-groups');
const tabPhrases = document.getElementById('tab-slang');
const tabProfile = document.getElementById('tab-profile');
const scrCards   = document.getElementById('screen-cards');
const scrGroups  = document.getElementById('screen-groups');
const scrPhrases = document.getElementById('screen-slang');
const scrProfile = document.getElementById('screen-profile');

export function showTab(tab) {
  [scrCards, scrGroups, scrPhrases, scrProfile].forEach(s => s.classList.remove('active'));
  [tabCards, tabGroups, tabPhrases, tabProfile].forEach(t => t.classList.remove('active'));
  if (tab === 'cards')        { scrCards.classList.add('active');   tabCards.classList.add('active'); }
  else if (tab === 'groups')  { scrGroups.classList.add('active');  tabGroups.classList.add('active'); renderGroups(); }
  else if (tab === 'slang')   { scrPhrases.classList.add('active'); tabPhrases.classList.add('active'); renderSlang(); }
  else                        { scrProfile.classList.add('active'); tabProfile.classList.add('active'); renderProfile(); }
}
tabCards.onclick   = () => showTab('cards');
tabGroups.onclick  = () => showTab('groups');
tabPhrases.onclick = () => showTab('slang');
tabProfile.onclick = () => showTab('profile');

/* ── PROFILE ── */
export function renderProfile() {
  const container = document.getElementById('profile-scroll');
  const levels = [1, 2, 3, 4, 5, 6];

  function computeStats() {
    const filtered = state.CHARACTERS.filter(c => state.activeHskLevels.has(c.hsk) && isAvailable(c.hsk));
    const total    = filtered.length;
    const knownN   = filtered.filter(c => state.known.has(c.char)).length;
    const reviewN  = filtered.filter(c => state.unknown.has(c.char)).length;
    const leftN    = total - knownN - reviewN;
    const totalCov = filtered.reduce((s, c) => s + (c.coverage ?? 0), 0);
    const knownCov = filtered.filter(c => state.known.has(c.char)).reduce((s, c) => s + (c.coverage ?? 0), 0);
    const pct = totalCov ? Math.round(knownCov / totalCov * 100) : 0;
    return { total, knownN, reviewN, leftN, pct };
  }

  function updateStats() {
    const { knownN, reviewN, leftN, pct } = computeStats();
    container.querySelector('#p-known').textContent  = knownN;
    container.querySelector('#p-review').textContent = reviewN;
    container.querySelector('#p-left').textContent   = leftN;
    container.querySelector('#p-pct').textContent    = pct + '%';
    container.querySelector('#p-bar').style.width    = pct + '%';
  }

  const { knownN, reviewN, leftN, pct } = computeStats();

  const STATUS_CONFIG = [
    { key: 'left',   label: 'Left',   cls: 'status-left'   },
    { key: 'know',   label: 'Know',   cls: 'status-know'   },
    { key: 'review', label: 'Review', cls: 'status-review' },
  ];
  const statusPills = STATUS_CONFIG.map(({ key, label, cls }) => {
    const active = state.activeStatuses.has(key);
    return `<button class="status-filter-pill ${cls} ${active ? 'active' : ''}" data-status="${key}">${label}</button>`;
  }).join('');

  const filterPills = levels.map(hsk => {
    const group = state.CHARACTERS.filter(c => c.hsk === hsk);
    if (!group.length) return '';
    const active = state.activeHskLevels.has(hsk);
    const locked = state.userPlan === 'free' && !isAvailable(hsk);
    return `<button class="hsk-filter-pill hsk-${hsk} ${active ? 'active' : ''} ${locked ? 'locked' : ''}" data-hsk="${hsk}" ${locked ? 'disabled' : ''} style="${locked ? 'opacity:.35;cursor:not-allowed' : ''}" title="${locked ? 'Upgrade to Pro to unlock' : ''}">
      ${locked ? '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="margin-right:2px;vertical-align:middle"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : ''}HSK ${hsk}
    </button>`;
  }).join('');

  const accountHTML = state.supaUser
    ? `<div class="profile-section">
        <div class="words-title">Account</div>
        <div class="info-cell full" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div class="lbl">Signed in as</div>
            <div class="val" style="font-size:.8rem;margin-top:2px">${state.supaUser.email}</div>
          </div>
          <button id="signOutBtn" style="padding:6px 14px;border-radius:999px;background:var(--surf);border:1px solid var(--bdr);color:var(--muted);font-size:.68rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">Sign out</button>
        </div>
        ${state.userPlan === 'pro' ? `
        <div class="info-cell full" style="display:flex;align-items:center;gap:8px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--green)"><polyline points="20 6 9 17 4 12"/></svg>
          <span style="font-size:.75rem;color:var(--green);font-weight:600">Pro — all levels unlocked</span>
        </div>` : ''}
      </div>`
    : `<div class="profile-section">
        <div class="words-title">Account</div>
        <div class="info-cell full" style="display:flex;flex-direction:column;gap:10px">
          <button id="signInGoogleBtn" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-radius:10px;background:var(--surf);border:1px solid var(--bdr);color:var(--txt);font-size:.8rem;font-weight:600;cursor:pointer;width:100%;box-sizing:border-box">
            <svg width="15" height="15" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.1-9.9 7.1-17z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6.2 0-11.5-4.2-13.4-9.9l-7.8 6C6.5 42.5 14.6 48 24 48z"/></svg>
            Continue with Google
          </button>
          <div style="display:flex;align-items:center;gap:8px;color:var(--faint);font-size:.62rem">
            <div style="flex:1;height:1px;background:var(--bdr)"></div>or<div style="flex:1;height:1px;background:var(--bdr)"></div>
          </div>
          <input id="authEmail" type="email" placeholder="Email" style="background:var(--bg);border:1px solid var(--bdr);border-radius:10px;padding:9px 12px;font:inherit;font-size:.8rem;color:var(--txt);outline:none;width:100%;box-sizing:border-box"/>
          <input id="authPass" type="password" placeholder="Password" style="background:var(--bg);border:1px solid var(--bdr);border-radius:10px;padding:9px 12px;font:inherit;font-size:.8rem;color:var(--txt);outline:none;width:100%;box-sizing:border-box"/>
          <div id="authError" style="font-size:.62rem;color:#c04050;min-height:.8rem;margin-top:-4px"></div>
          <div style="display:flex;gap:8px">
            <button id="signInBtn" style="flex:1;padding:9px;border-radius:10px;background:var(--surf);border:1px solid var(--bdr);color:var(--txt);font-size:.78rem;font-weight:600;cursor:pointer">Sign in</button>
            <button id="signUpBtn" style="flex:1;padding:9px;border-radius:10px;background:var(--green-bg);border:1px solid rgba(104,191,138,.25);color:var(--green);font-size:.78rem;font-weight:600;cursor:pointer">Register</button>
          </div>
        </div>
      </div>`;

  container.innerHTML = `
    <div class="profile-section">
      <div class="words-title">Progress</div>
      <div class="info-row" style="grid-template-columns:1fr 1fr 1fr">
        <div class="info-cell" style="text-align:center">
          <div class="lbl">Known</div>
          <div class="val" style="color:var(--green);font-size:1.5rem" id="p-known">${knownN}</div>
        </div>
        <div class="info-cell" style="text-align:center">
          <div class="lbl">Review</div>
          <div class="val" style="color:var(--blue);font-size:1.5rem" id="p-review">${reviewN}</div>
        </div>
        <div class="info-cell" style="text-align:center">
          <div class="lbl">Left</div>
          <div class="val" style="font-size:1.5rem" id="p-left">${leftN}</div>
        </div>
      </div>
      <div class="info-cell full" style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="lbl">Overall progress</div>
          <div class="lbl" id="p-pct">${pct}%</div>
        </div>
        <div class="hsk-full-bar"><div class="hsk-full-bar-fill hsk-2-fill" id="p-bar" style="width:${pct}%"></div></div>
        <p style="font-size:.6rem;color:var(--faint);line-height:1.5;margin:0">of typical Chinese text — Top 500 chars cover 75%. Mark characters as learned to see your progress.</p>
      </div>
    </div>

    <div class="profile-section">
      <div class="words-title">Filters</div>
      <div class="hsk-filter-row">${filterPills}</div>
      <p class="filter-hint">Select the HSK levels to include in your card deck.</p>
      <div class="status-filter-row">${statusPills}</div>
      <p class="filter-hint">Select which card statuses to include in your deck.</p>
    </div>

    ${state.supaUser && state.userPlan !== 'pro' ? `
    <div class="profile-section">
      <div class="words-title">shuazi Pro</div>
      <div class="info-cell full" style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="font-size:.78rem;color:var(--txt);font-weight:600">Unlock all 6 HSK levels</div>
          <div style="font-size:.68rem;color:var(--faint);line-height:1.5">One-time payment. Study over 1,500 characters across all HSK levels.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:.68rem;color:var(--muted)">
          <div style="display:flex;align-items:center;gap:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--green);flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>HSK 1–6 complete (1,500+ characters)</div>
          <div style="display:flex;align-items:center;gap:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--green);flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>Progress sync across all devices</div>
          <div style="display:flex;align-items:center;gap:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--green);flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>One-time payment, no subscription</div>
        </div>
        <button id="upgradeBannerBtn" style="padding:11px;border-radius:10px;background:var(--green-bg);border:1px solid rgba(104,191,138,.25);color:var(--green);font-size:.82rem;font-weight:700;cursor:pointer;width:100%">Upgrade to Pro · €1.99</button>
      </div>
    </div>` : ''}

    ${accountHTML}

    <div class="profile-section">
      <button id="resetBtn" style="width:100%;padding:11px;border-radius:12px;background:rgba(186,13,31,.06);border:1px solid rgba(186,13,31,.12);color:var(--muted);font-size:.78rem;font-weight:600;cursor:pointer">Reset progress</button>
    </div>
  `;

  if (state.userPlan !== 'pro') {
    container.querySelector('#upgradeBannerBtn')?.addEventListener('click', () => {
      if (!state.supaUser) { container.querySelector('#authEmail')?.focus(); return; }
      gtag('event', 'upgrade_to_pro_click');
      startCheckout();
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
    container.querySelector('#signInBtn').addEventListener('click', async () => {
      errEl.textContent = ''; errEl.style.color = '#c04050';
      const { error } = await supa.auth.signInWithPassword({ email: emailEl.value.trim(), password: passEl.value });
      if (error) errEl.textContent = error.message;
    });
    container.querySelector('#signUpBtn').addEventListener('click', async () => {
      errEl.textContent = ''; errEl.style.color = '#c04050';
      const { error } = await supa.auth.signUp({ email: emailEl.value.trim(), password: passEl.value });
      if (error) errEl.textContent = error.message;
      else { errEl.style.color = 'var(--green)'; errEl.textContent = 'Check your email to confirm!'; }
    });
  }

  container.querySelectorAll('.hsk-filter-pill:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const hsk = +btn.dataset.hsk;
      if (state.activeHskLevels.has(hsk)) {
        if (state.activeHskLevels.size > 1) { state.activeHskLevels.delete(hsk); btn.classList.remove('active'); }
      } else {
        state.activeHskLevels.add(hsk); btn.classList.add('active');
      }
      state.deck = buildDeck(state.CHARACTERS);
      render();
      updateStats();
    });
  });

  container.querySelectorAll('.status-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.status;
      if (state.activeStatuses.has(key)) {
        if (state.activeStatuses.size > 1) { state.activeStatuses.delete(key); btn.classList.remove('active'); }
      } else {
        state.activeStatuses.add(key); btn.classList.add('active');
      }
      state.deck = buildDeck(state.CHARACTERS);
      render();
      updateStats();
    });
  });

  container.querySelector('#resetBtn').addEventListener('click', () => {
    const filtered = state.CHARACTERS.filter(c => isAvailable(c.hsk));
    const knownN  = filtered.filter(c => state.known.has(c.char)).length;
    const reviewN = filtered.filter(c => state.unknown.has(c.char)).length;
    document.getElementById('reset-stats').innerHTML = `
      <div><div style="font-size:1.3rem;font-weight:700;color:var(--green)">${knownN}</div><div style="font-size:.6rem;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-top:2px">Known</div></div>
      <div><div style="font-size:1.3rem;font-weight:700;color:var(--blue)">${reviewN}</div><div style="font-size:.6rem;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-top:2px">Review</div></div>
      <div><div style="font-size:1.3rem;font-weight:700">${knownN + reviewN}</div><div style="font-size:.6rem;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-top:2px">Total</div></div>
    `;
    const rb = document.getElementById('reset-backdrop');
    rb.style.display = 'flex';
    rb.style.opacity = '0';
    requestAnimationFrame(() => { rb.style.transition = 'opacity 200ms ease'; rb.style.opacity = '1'; });
  });

  document.getElementById('resetCancelBtn').onclick  = () => closeResetModal();
  document.getElementById('resetConfirmBtn').onclick = () => {
    state.known.clear(); state.unknown.clear();
    state.deck = buildDeck(state.CHARACTERS);
    render(); saveState();
    closeResetModal();
    setTimeout(() => renderProfile(), 200);
  };

  document.getElementById('reset-backdrop').onclick = e => {
    if (e.target === document.getElementById('reset-backdrop')) closeResetModal();
  };

  const rm = document.getElementById('reset-modal');
  let rsY = 0, rsDy = 0;
  rm.addEventListener('pointerdown', e => { rsY = e.clientY; rsDy = 0; rm.style.transition = 'none'; });
  rm.addEventListener('pointermove', e => { rsDy = e.clientY - rsY; if (rsDy > 0) rm.style.transform = `translateY(${rsDy}px)`; });
  rm.addEventListener('pointerup', () => {
    rm.style.transition = 'transform 300ms ease';
    if (rsDy > 80) { closeResetModal(); } else { rm.style.transform = ''; }
  });
}

/* ── SLANG ── */
function shuffleArr(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = 0 | Math.random() * (i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; }

function makeSlangCardEl(phrase) {
  const card = document.createElement('div');
  card.className = 'card phrase-card';
  card.innerHTML = `
    <div class="phrase-inner">
      <div class="phrase-hanzi">${phrase.id}</div>
      <div class="phrase-pinyin">${phrase.pinyin}</div>
      <div class="phrase-literal">${phrase.literal}</div>
      <div class="phrase-divider"></div>
      <div class="phrase-meaning">${phrase.meaning}</div>
      ${phrase.origin ? `<div class="phrase-origin">${phrase.origin}</div>` : ''}
      ${phrase.image ? `<img src="./images/${phrase.image}" alt="${phrase.id}" class="phrase-img" onerror="this.style.display='none'"/>` : ''}
    </div>
  `;
  return card;
}

export function renderSlang() {
  const deckPhrEl = document.getElementById('deck-slang');
  if (!state.slangDeck.length) state.slangDeck = shuffleArr(state.PHRASES);
  deckPhrEl.innerHTML = '';
  const stack = state.slangDeck.slice(0, 3);
  [...stack].reverse().forEach((phrase, ri) => {
    const i = stack.length - 1 - ri;
    const card = makeSlangCardEl(phrase);
    card.style.zIndex = i + 1;
    card.style.transform = i === stack.length - 1 ? '' : `scale(${0.97 - (stack.length - 1 - i) * 0.01}) translateY(${(stack.length - 1 - i) * 6}px)`;
    deckPhrEl.appendChild(card);
    if (i === stack.length - 1) attachPhraseSwipe(card, phrase);
  });
}

function attachPhraseSwipe(cardEl, phrase) {
  let startX = 0, dx = 0, active = false;
  cardEl.addEventListener('pointerdown', e => {
    startX = e.clientX; dx = 0; active = true;
    cardEl.style.transition = 'none';
    cardEl.setPointerCapture(e.pointerId);
  });
  cardEl.addEventListener('pointermove', e => {
    if (!active) return;
    dx = e.clientX - startX;
    cardEl.style.transform = `translateX(${dx}px) rotate(${dx * 0.04}deg)`;
    cardEl.style.opacity = String(Math.max(.7, 1 - Math.abs(dx) / 300));
  });
  cardEl.addEventListener('pointerup', () => {
    if (!active) return; active = false;
    if (Math.abs(dx) > 80) {
      const dir = dx > 0 ? 1 : -1;
      cardEl.style.transition = 'transform 300ms ease, opacity 300ms ease';
      cardEl.style.transform = `translateX(${dir * 120}%) rotate(${dir * 20}deg)`;
      cardEl.style.opacity = '0';
      state.slangDeck.splice(state.slangDeck.indexOf(phrase), 1);
      if (!state.slangDeck.length) state.slangDeck = shuffleArr(state.PHRASES);

      const deckPhrEl = document.getElementById('deck-slang');
      const bgCards = [...deckPhrEl.querySelectorAll('.phrase-card')].filter(c => c !== cardEl);

      if (bgCards.length === 0) { setTimeout(renderSlang, 310); return; }

      const newStack = state.slangDeck.slice(0, 3);
      const N = newStack.length;
      bgCards.forEach((bgCard, i) => {
        const newI = N - bgCards.length + i;
        bgCard.style.transition = 'transform 200ms ease';
        bgCard.style.zIndex = newI + 1;
        bgCard.style.transform = newI === N - 1 ? '' : `scale(${0.97 - (N - 1 - newI) * 0.01}) translateY(${(N - 1 - newI) * 6}px)`;
      });

      const newTopCard = bgCards[bgCards.length - 1];
      setTimeout(() => {
        cardEl.remove();
        if (state.slangDeck.length >= 3) {
          const newCard = makeSlangCardEl(state.slangDeck[2]);
          newCard.style.zIndex = 1;
          newCard.style.transform = `scale(${0.97 - (N - 1) * 0.01}) translateY(${(N - 1) * 6}px)`;
          deckPhrEl.insertBefore(newCard, deckPhrEl.firstChild);
        }
        if (newTopCard.isConnected) attachPhraseSwipe(newTopCard, state.slangDeck[0]);
      }, 310);
    } else {
      cardEl.style.transition = 'transform 300ms ease, opacity 300ms ease';
      cardEl.style.transform = '';
      cardEl.style.opacity = '1';
    }
  });
  cardEl.addEventListener('pointercancel', () => { active = false; cardEl.style.transform = ''; cardEl.style.opacity = '1'; });
}

/* ── SORT & SEARCH ── */
document.getElementById('sortBtn').onclick = () => {
  const cycle  = ['pinyin', 'productive', 'coverage', 'stroke'];
  const labels = { pinyin: 'Pinyin', productive: 'Productive', coverage: 'Coverage', stroke: 'Stroke' };
  state.gridSort = cycle[(cycle.indexOf(state.gridSort) + 1) % cycle.length];
  document.getElementById('sortLabel').textContent = labels[state.gridSort];
  renderGroups();
};

const searchBarWrap   = document.getElementById('searchBarWrap');
const searchInput     = document.getElementById('searchInput');
const searchClear     = document.getElementById('searchClear');
const searchToggleBtn = document.getElementById('searchToggleBtn');

searchToggleBtn.addEventListener('click', () => {
  const open = searchBarWrap.classList.toggle('open');
  document.getElementById('searchHint').style.display = open ? 'block' : 'none';
  if (open) searchInput.focus();
  else { searchInput.value = ''; state.gridSearch = ''; renderGroups(); }
});
searchInput.addEventListener('input', () => { state.gridSearch = searchInput.value; renderGroups(); });
searchClear.addEventListener('click', () => { searchInput.value = ''; state.gridSearch = ''; renderGroups(); searchInput.focus(); });

/* ── THEME ── */
export function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('shuazi-theme', t); } catch (e) {}
  const icon = t === 'dark'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  ['themeBtn', 'themeBtnG', 'themeBtnP', 'themeBtnPh'].forEach(id => {
    document.getElementById(id).innerHTML = icon;
  });
}

const toggleTheme = () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
['themeBtn', 'themeBtnG', 'themeBtnP', 'themeBtnPh'].forEach(id => {
  document.getElementById(id).onclick = toggleTheme;
});

/* ── KEYBOARD ── */
document.addEventListener('keydown', e => {
  const deckEl = document.getElementById('deck');
  const top = deckEl.querySelector('.card.top'); if (!top) return;
  if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') classifyKnown();
  else if (e.key === 'ArrowLeft'  || e.key.toLowerCase() === 'a') classifyLeft();
  else if (e.key === 'ArrowUp'    || e.key.toLowerCase() === 'w') classifyReview();
  else if (e.key === ' ') { e.preventDefault(); top.querySelector('.tz-center')?.click(); }
  else if (e.key === 'i') top.querySelector('.tz-right')?.click();
});
