/* ── ONBOARDING COACH ──
   One-time cues that teach the app's two non-obvious gestures:
   • Cards  — the real top card nudges itself left → right → up once, so the
     swipe is learned by watching (no modal, no text to read).
   • Groups — a light tip: long-press a tile to mark what you know.
   Each cue shows once, then remembers via localStorage so it never nags again.

   Dev preview: add ?coach=swipe or ?coach=groups to force one, ignoring the
   "already seen" flag. */

import { t } from './i18n.js';

const SWIPE_KEY  = 'coach-swipe-seen';
const GROUPS_KEY = 'coach-groups-seen';

const DEBUG = new URLSearchParams(location.search).get('coach');

const seen     = key => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const markSeen = key => { try { localStorage.setItem(key, '1'); } catch { /* ignore */ } };

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── Cards: the real top card auto-swipes once ──
export function maybeDemoSwipe() {
  if (DEBUG ? DEBUG !== 'swipe' : seen(SWIPE_KEY)) return;
  const card = document.querySelector('#deck .card.top');
  if (!card) return;

  markSeen(SWIPE_KEY);                 // only ever demo once
  if (reducedMotion()) return;         // honour the user's motion preference

  card.classList.add('demo-swipe');
  // Cancel the moment the user grabs the card, so a real drag isn't blocked by
  // the running animation; otherwise clean up when it finishes.
  const stop = () => { card.classList.remove('demo-swipe'); clearTimeout(timer); };
  card.addEventListener('pointerdown', stop, { once: true });
  const timer = setTimeout(stop, 3300);
}

// ── Groups: lightweight long-press tip (non-modal, auto-dismisses) ──
export function maybeShowGroupsCoach() {
  if (DEBUG ? DEBUG !== 'groups' : seen(GROUPS_KEY)) return;
  if (document.querySelector('.coach-tip')) return;

  const tip = document.createElement('div');
  tip.className = 'coach-tip';
  tip.setAttribute('role', 'status');
  tip.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V5a2 2 0 0 1 4 0v6"/><path d="M12 11V4a2 2 0 0 1 4 0v7"/><path d="M16 11V6a2 2 0 0 1 4 0v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-6.3-3.9L4 15a2 2 0 0 1 3.3-2.2L8 13.5"/></svg>
    <span>${t('coach.groups')}</span>
    <button class="coach-tip-x" type="button" aria-label="${t('pwa.dismiss')}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  document.body.appendChild(tip);
  requestAnimationFrame(() => tip.classList.add('show'));

  let timer = 0;
  const close = () => {
    markSeen(GROUPS_KEY);
    clearTimeout(timer);
    tip.classList.remove('show');
    setTimeout(() => tip.remove(), 260);
  };
  tip.querySelector('.coach-tip-x').addEventListener('click', close);
  timer = setTimeout(close, 7000);
}
