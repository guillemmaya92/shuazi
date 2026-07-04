/* ── PULL-TO-REFRESH ──
   iOS-style pull gesture: drag down from the very top of a scroll container to
   trigger an action (e.g. clear results / filters). Shows a segmented spinner
   that fills bar-by-bar with rubber-band resistance, the content follows the
   pull and snaps back, and on release the ring spins briefly before `onRefresh`
   runs (so the content doesn't vanish before the spinner has gone).

   Wiring (see styles.css .pull-disc / .pull-spinner / .pull-follow):
     setupPullRefresh({ scroll, disc, content, onRefresh, haptic,
                        trigger, max, damp, label, pullText, readyText })
   `trigger`/`max`/`damp` tune the gesture (bigger trigger = a longer, harder
   pull). `label` is an optional element that shows `pullText`, switching to
   `readyText` once the threshold is crossed. */
export function setupPullRefresh({ scroll, disc, content, onRefresh, haptic,
                                   trigger = 56, max = 92, damp = 80,
                                   label = null, pullText = '', readyText = '',
                                   exitUp = false }) {
  if (!scroll || !disc) return;

  const TRIGGER = trigger;   // pull distance (px, after damping) that fires
  const MAX     = max;       // asymptote — the ring can't be dragged past this
  const DAMP    = damp;      // rubber-band stiffness (higher = looser)
  // How far the disc/caption lag the content as it's pulled down. The larger this
  // is relative to the disc's ~40px height offset, the bigger the gap left between
  // the wheel and the content below it (~16px here, instead of touching).
  const DISC_LEAD = 56;

  const bars = Array.from(disc.querySelectorAll('.pull-spinner line'));
  // Graduated opacity around the ring (comet trail); the brightest bar leads.
  const barBase = i => 0.14 + (i / (bars.length - 1)) * 0.86;
  // Reveal the first `frac` (0..1) of bars, iOS-style — they light up one by one.
  const setBars = frac => {
    const n = Math.round(frac * bars.length);
    bars.forEach((b, i) => { b.style.opacity = i < n ? barBase(i).toFixed(2) : '0'; });
  };

  // Optional caption that sits just above the disc (in the gap opened by the
  // pull, so it never overlaps the content) and flips text once armed. It shares
  // the disc's transform (dist - DISC_LEAD) to stay glued to the wheel. `pullText` /
  // `readyText` may be a function (resolved each frame) so a live language change
  // is reflected without re-wiring.
  const resolve = v => (typeof v === 'function' ? v() : v);
  const setLabel = (frac, isReady, dist) => {
    if (!label) return;
    label.textContent = isReady ? resolve(readyText) : resolve(pullText);
    label.style.opacity = frac.toString();
    label.style.transform = `translateY(${dist - DISC_LEAD}px)`;
    label.classList.toggle('ready', isReady);
  };

  let startY = 0, startX = 0, active = false, locked = false, ready = false;

  const reset = () => {
    disc.classList.remove('dragging', 'ready', 'spinning', 'exiting');
    disc.style.opacity = '';
    disc.style.transform = '';
    bars.forEach(b => { b.style.opacity = ''; });
    if (label) { label.classList.remove('dragging', 'ready', 'exiting'); label.style.opacity = ''; label.style.transform = ''; }
    if (content) { content.classList.remove('dragging'); content.style.transform = ''; }
  };

  scroll.addEventListener('touchstart', e => {
    // Only arm at the very top, single finger, and not mid-refresh.
    if (e.touches.length !== 1 || scroll.scrollTop > 0 || disc.classList.contains('spinning')) {
      active = false; return;
    }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX;
    active = true; locked = false; ready = false;
  }, { passive: true });

  scroll.addEventListener('touchmove', e => {
    if (!active) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (!locked) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      // Engage only on a clear downward pull while pinned at the top.
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || scroll.scrollTop > 0) { active = false; return; }
      locked = true;
      disc.classList.add('dragging');
      if (label) label.classList.add('dragging');
      if (content) content.classList.add('dragging');
    }
    e.preventDefault();                          // own the gesture (non-passive)
    const dist = MAX * (1 - Math.exp(-dy / DAMP)); // rubber-band resistance
    const frac = Math.min(1, dist / TRIGGER);
    const nowReady = dist >= TRIGGER;
    if (nowReady && !ready) haptic?.();          // tick the instant the threshold is crossed
    ready = nowReady;
    disc.style.opacity = frac.toString();
    disc.style.transform = `translateY(${dist - DISC_LEAD}px)`;
    disc.classList.toggle('ready', ready);
    setBars(frac);                               // bars fill in as you pull
    setLabel(frac, ready, dist);                 // caption follows + flips text
    if (content) content.style.transform = `translateY(${dist}px)`;  // content follows
  }, { passive: false });

  const end = () => {
    if (!active) return;
    active = false;
    if (!locked) return;
    if (content) { content.classList.remove('dragging'); content.style.transform = ''; }  // snap content back
    if (ready && exitUp) {
      // Glide the wheel + caption up and fade them, together with the content the
      // action clears — everything rises off the top in sync (see .exiting in CSS).
      haptic?.();
      disc.classList.remove('dragging', 'ready');
      disc.classList.add('exiting');
      disc.style.opacity = '0';
      disc.style.transform = 'translateY(-48px)';
      if (label) {
        label.classList.remove('dragging');
        label.classList.add('exiting');
        label.style.opacity = '0';
        label.style.transform = 'translateY(-48px)';
      }
      onRefresh?.();                             // content glides up at the same time
      setTimeout(reset, 340);
    } else if (ready) {
      disc.classList.remove('dragging', 'ready');
      disc.classList.add('spinning');
      disc.style.opacity = '1';
      disc.style.transform = 'translateY(8px)';
      setBars(1);                                // full ring, then CSS spins it
      if (label) { label.classList.remove('dragging'); label.style.opacity = '0'; }  // fade the caption, keep the wheel
      haptic?.();
      // Spin first, then run the action as the ring retracts.
      setTimeout(() => { try { onRefresh?.(); } finally { reset(); } }, 600);
    } else {
      reset();
    }
  };
  scroll.addEventListener('touchend', end, { passive: true });
  scroll.addEventListener('touchcancel', end, { passive: true });
}
