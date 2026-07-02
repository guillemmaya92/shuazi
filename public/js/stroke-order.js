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

  const backdrop = document.createElement('div');
  backdrop.className = 'stroke-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', t('stroke.title'));
  backdrop.innerHTML = `
    <div class="stroke-sheet">
      <button class="stroke-x" type="button" aria-label="${t('pwa.dismiss')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <div class="stroke-title">${t('stroke.title')}</div>
      <div class="stroke-targets"></div>
      <div class="stroke-actions">
        <button class="stroke-btn stroke-replay" type="button" aria-label="${t('stroke.replay')}" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <button class="stroke-btn stroke-radical" type="button" aria-label="${t('stroke.radical')}" aria-pressed="false" disabled>
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.7s6.5 6 6.5 10.8a6.5 6.5 0 0 1-13 0C5.5 8.7 12 2.7 12 2.7Z"/></svg>
        </button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));

  const close = () => { backdrop.classList.remove('show'); setTimeout(() => backdrop.remove(), 220); };
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.stroke-x').addEventListener('click', close);

  const targetsWrap = backdrop.querySelector('.stroke-targets');
  const replayBtn   = backdrop.querySelector('.stroke-replay');
  const radicalBtn  = backdrop.querySelector('.stroke-radical');

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
  const outlineColor = light ? 'rgba(28,21,16,.12)' : 'rgba(232,240,244,.14)';
  const accentColor  = cs.getPropertyValue('--blue').trim() || '#64a0e6';
  const radicalColor = strokeColor;   // uniform by default; the radical button tints it
  const size = chars.length > 2 ? 96 : 132;

  const writers = chars.map(ch => {
    const target = document.createElement('div');
    target.className = 'stroke-target';
    target.style.width = target.style.height = size + 'px';
    targetsWrap.appendChild(target);
    const writer = HW.create(target, ch, {
      width: size, height: size, padding: 6,
      showOutline: true,
      strokeColor, outlineColor, radicalColor,
      strokeAnimationSpeed: 1, delayBetweenStrokes: 220,
      onLoadCharDataError: () => { target.innerHTML = `<span class="stroke-missing">${ch}</span>`; },
    });
    target.addEventListener('click', () => writer.animateCharacter());   // tap a glyph to replay it
    return writer;
  });

  const playAll = () => writers.forEach((w, i) => setTimeout(() => w.animateCharacter(), i * 140));
  replayBtn.disabled = false;
  replayBtn.addEventListener('click', playAll);

  // Radical toggle: recolour the radical strokes on/off (uniform ⇄ accent).
  let radicalOn = false;
  radicalBtn.disabled = false;
  radicalBtn.addEventListener('click', () => {
    radicalOn = !radicalOn;
    const col = radicalOn ? accentColor : strokeColor;
    writers.forEach(w => w.updateColor('radicalColor', col));
    radicalBtn.classList.toggle('active', radicalOn);
    radicalBtn.setAttribute('aria-pressed', String(radicalOn));
  });

  playAll();
}
