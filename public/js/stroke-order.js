/* ── STROKE ORDER ──
   Taps on a character open an animated stroke-order overlay. HanziWriter is
   loaded lazily from the same CDN as supabase-js, and its per-character data is
   fetched on demand. Online-only: the service worker passes CDN requests
   straight to the network (no offline caching), just like supabase. */

import { t } from './i18n.js';

const HW_SRC = 'https://cdn.jsdelivr.net/npm/hanzi-writer@3/dist/hanzi-writer.min.js';
let hwPromise = null;

function loadHanziWriter() {
  if (window.HanziWriter) return Promise.resolve(window.HanziWriter);
  if (!hwPromise) {
    hwPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HW_SRC; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => resolve(window.HanziWriter);
      s.onerror = () => { hwPromise = null; reject(new Error('hanzi-writer failed to load')); };
      document.head.appendChild(s);
    });
  }
  return hwPromise;
}

// CJK Unified Ideographs (+ Extension A start + Compatibility) — skip pinyin,
// punctuation, latin so a word like "3D" or "の" doesn't feed HanziWriter junk.
const isCJK = ch => /[㐀-鿿豈-﫿]/.test(ch);

export async function openStrokeOrder(char) {
  const chars = [...String(char || '')].filter(isCJK);
  if (!chars.length) return;
  if (document.querySelector('.stroke-backdrop')) return;   // only one overlay at a time

  const prevFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'stroke-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', t('stroke.title'));
  backdrop.innerHTML = `
    <div class="stroke-sheet" tabindex="-1">
      <div class="stroke-targets"></div>
      <div class="stroke-actions">
        <button class="stroke-nav stroke-prev" type="button" aria-label="${t('stroke.prev')}" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <button class="stroke-btn stroke-replay" type="button" aria-label="${t('stroke.replay')}" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <button class="stroke-btn stroke-write" type="button" aria-label="${t('stroke.write')}" aria-pressed="false" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="stroke-btn stroke-radical" type="button" aria-label="${t('stroke.radical')}" aria-pressed="false" disabled>
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.7s6.5 6 6.5 10.8a6.5 6.5 0 0 1-13 0C5.5 8.7 12 2.7 12 2.7Z"/></svg>
        </button>
        <button class="stroke-btn stroke-grid" type="button" aria-label="${t('stroke.grid')}" aria-pressed="false" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/></svg>
        </button>
        <button class="stroke-nav stroke-next" type="button" aria-label="${t('stroke.next')}" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 220);
    prevFocus?.focus?.();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  requestAnimationFrame(() => { backdrop.classList.add('show'); backdrop.querySelector('.stroke-sheet').focus(); });

  const targetsWrap = backdrop.querySelector('.stroke-targets');
  const replayBtn   = backdrop.querySelector('.stroke-replay');
  const writeBtn    = backdrop.querySelector('.stroke-write');
  const radicalBtn  = backdrop.querySelector('.stroke-radical');
  const gridBtn     = backdrop.querySelector('.stroke-grid');
  const prevBtn     = backdrop.querySelector('.stroke-prev');
  const nextBtn     = backdrop.querySelector('.stroke-next');

  // Fit the canvas to the sheet so it never overflows on small phones: the sheet
  // is min(384, viewport − backdrop padding); subtract its own padding and the
  // room the side button column needs, then cap by the number of characters.
  const sheetInner = Math.min(440, window.innerWidth - 32) - 40;
  const size = Math.round(Math.max(96, Math.min(288, sheetInner)));
  targetsWrap.style.minHeight = size + 'px';

  let HW;
  try {
    HW = await loadHanziWriter();
  } catch {
    targetsWrap.innerHTML = `<div class="stroke-error">${t('stroke.error')}</div>`;
    return;
  }
  if (!backdrop.isConnected) return;   // dismissed while the library was loading

  // Match the drawing to the active theme: a solid dark stroke on light, a light
  // stroke on dark, and a very faint outline (silhouette) in both. The radical
  // uses the same colour as the rest, so every stroke is uniform.
  const cs = getComputedStyle(document.documentElement);
  const light = document.documentElement.dataset.theme !== 'dark';
  const strokeColor  = light ? '#1c1510' : (cs.getPropertyValue('--txt').trim() || '#e8f0f4');
  // Unpainted silhouette: a solid light tint (not transparency) so it reads evenly.
  const outlineColor = light ? '#ddd7cf' : '#39434c';
  const accentColor  = cs.getPropertyValue('--blue').trim() || '#64a0e6';
  const radicalColor = strokeColor;   // uniform by default; the radical button tints it

  let idx = 0;
  let quizzing = false;
  let radicalOn = false;

  // One target/writer per character; only the current one is visible (words step
  // through them with the side arrows, so we never show more than one glyph).
  const targetEls = [];
  const writers = chars.map((ch, i) => {
    const target = document.createElement('div');
    target.className = 'stroke-target';
    target.style.width = target.style.height = size + 'px';
    if (i !== 0) target.style.display = 'none';
    targetsWrap.appendChild(target);
    targetEls.push(target);
    const writer = HW.create(target, ch, {
      width: size, height: size, padding: 6,
      showOutline: true,
      strokeColor, outlineColor, radicalColor, drawingColor: accentColor,
      drawingWidth: Math.round(size * 0.11),
      strokeAnimationSpeed: 1, delayBetweenStrokes: 220,
      onLoadCharDataError: () => { target.innerHTML = `<span class="stroke-missing">${ch}</span>`; },
    });
    target.addEventListener('click', () => { if (!quizzing) writer.animateCharacter(); });
    return writer;
  });

  const current = () => writers[idx];
  const setWriting = on => {
    quizzing = on;
    writeBtn.classList.toggle('active', on);
    writeBtn.setAttribute('aria-pressed', String(on));
  };
  const setRadical = on => {
    radicalOn = on;
    current().updateColor('radicalColor', on ? accentColor : strokeColor);
    radicalBtn.classList.toggle('active', on);
    radicalBtn.setAttribute('aria-pressed', String(on));
  };
  const stopQuiz = () => { if (quizzing) { current().cancelQuiz(); current().showCharacter(); setWriting(false); } };
  const play = () => { stopQuiz(); current().animateCharacter(); };

  replayBtn.disabled = false;
  replayBtn.addEventListener('click', play);

  writeBtn.disabled = false;
  writeBtn.addEventListener('click', () => {
    if (quizzing) { stopQuiz(); return; }
    setWriting(true);
    current().quiz({ showHintAfterMisses: 2, onComplete: () => setWriting(false) });
  });

  radicalBtn.disabled = false;
  radicalBtn.addEventListener('click', () => setRadical(!radicalOn));

  // Field grid (米字格): a faint dashed frame with a cross + diagonals behind the
  // glyph, to gauge stroke proportion/placement. Toggled on every target so it
  // persists while stepping through a word's characters.
  let gridOn = false;
  const setGrid = on => {
    gridOn = on;
    targetEls.forEach(el => el.classList.toggle('grid-on', on));
    gridBtn.classList.toggle('active', on);
    gridBtn.setAttribute('aria-pressed', String(on));
  };
  gridBtn.disabled = false;
  gridBtn.addEventListener('click', () => setGrid(!gridOn));

  // Multi-character words: step through one glyph at a time with the side arrows.
  if (chars.length > 1) {
    prevBtn.hidden = nextBtn.hidden = false;
    const show = i => {
      stopQuiz();
      if (radicalOn) setRadical(false);
      targetEls[idx].style.display = 'none';
      idx = i;
      targetEls[idx].style.display = '';
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === chars.length - 1;
      current().animateCharacter();
    };
    prevBtn.addEventListener('click', () => { if (idx > 0) show(idx - 1); });
    nextBtn.addEventListener('click', () => { if (idx < chars.length - 1) show(idx + 1); });
    prevBtn.disabled = true;
  }

  play();
}
