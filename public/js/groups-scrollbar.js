// Custom draggable fast-scroll thumb for the long HSK grids.
//
// The native scrollbar can't be dragged on touch, so this adds a wide, always-
// grabbable pill pinned to the right edge of #groups-scroll. It's a pure
// scrollTop/scrollHeight mapping, so it behaves identically over the virtualized
// grids (which keep those metrics accurate via padding — see virtual-grid.js)
// and the plain ones. A section bubble shows the level/label under the thumb
// while dragging, so long flicks land where you expect.
//
// The module owns its DOM (created lazily on <body>) and is driven by
// `refreshGroupsScrollbar()`, which ui.js calls after every render and tab
// switch. It hides itself whenever the Groups screen isn't active or the content
// fits without scrolling.

let scrollEl, thumb, bar, bubble;
let dragging = false, dragStartY = 0, dragStartTop = 0;
let rafPending = false, hideTimer = null;

const IDLE_HIDE = 1100;   // ms of inactivity before the overlay thumb fades out

const MIN_THUMB = 44;   // comfortable touch target even on the huge HSK7 grid

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function refreshGroupsScrollbar() {
  scrollEl = document.getElementById('groups-scroll');
  if (!scrollEl) return;
  ensureEls();
  requestAnimationFrame(() => { update(); if (thumb.style.display !== 'none') show(); });
}

// Reveal the overlay thumb, then schedule it to fade back out once scrolling and
// dragging stop — keeps the grid clean while leaving a grab target when in use.
function show() {
  if (!thumb) return;
  thumb.classList.add('visible');
  clearTimeout(hideTimer);
  if (!dragging) hideTimer = setTimeout(() => thumb.classList.remove('visible'), IDLE_HIDE);
}

function ensureEls() {
  if (thumb) return;

  thumb = document.createElement('div');
  thumb.id = 'groupsScrollbar';
  thumb.setAttribute('aria-hidden', 'true');
  bar = document.createElement('div');
  bar.className = 'gsb-bar';
  thumb.appendChild(bar);

  bubble = document.createElement('div');
  bubble.id = 'groupsScrollbarBubble';

  document.body.append(thumb, bubble);

  scrollEl.addEventListener('scroll', () => {
    show();
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; update(); if (dragging) updateBubble(); });
  }, { passive: true });

  thumb.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('resize', () => requestAnimationFrame(update));

  // A content-height change (expand / collapse / filter) is not a scroll gesture,
  // so the overlay thumb must not stay on screen morphing its length through the
  // transition — collapsing a grid would otherwise make it visibly stretch as the
  // scroll height shrinks, then vanish. Snap it out crisply instead; it reappears
  // on the next real scroll. (While dragging, just keep its geometry in sync.)
  const content = document.getElementById('groups-content');
  if (content) new ResizeObserver(() => {
    if (dragging) { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; update(); }); } return; }
    clearTimeout(hideTimer);
    hide();
  }).observe(content);

  // Opening a side panel toggles a class on <body> but fires no scroll/resize —
  // watch it so the thumb hides/reappears with the panel.
  new MutationObserver(() => requestAnimationFrame(update))
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function metrics() {
  const view  = scrollEl.clientHeight;
  const total = scrollEl.scrollHeight;
  const max   = total - view;                       // max scrollTop
  const r     = scrollEl.getBoundingClientRect();
  const thumbH = Math.max(MIN_THUMB, view * view / total);
  const trackH = view - thumbH;                     // travel available to the thumb
  return { view, total, max, r, thumbH, trackH };
}

// The side panels (settings / account) slide in from the right edge — exactly
// where the thumb pins — so suppress it while one is open or being dragged.
const panelOpen = () => {
  const c = document.body.classList;
  return c.contains('settings-open')  || c.contains('settings-dragging')
      || c.contains('account-open')   || c.contains('account-dragging');
};

function update() {
  if (!thumb) return;
  const screen = document.getElementById('screen-groups');
  if (!screen || !screen.classList.contains('active') || panelOpen()) { hide(); return; }

  const { max, r, thumbH, trackH } = metrics();
  if (max <= 4 || r.height === 0) { hide(); return; }

  thumb.style.display = 'flex';
  thumb.style.height  = thumbH + 'px';
  thumb.style.right   = Math.max(0, window.innerWidth - r.right) + 'px';
  const frac = clamp(scrollEl.scrollTop / max, 0, 1);
  thumb.style.top     = (r.top + frac * trackH) + 'px';
}

function hide() {
  if (thumb)  thumb.style.display  = 'none';
  if (bubble) bubble.style.display = 'none';
}

function onDown(e) {
  e.preventDefault();
  dragging = true;
  thumb.setPointerCapture?.(e.pointerId);
  thumb.classList.add('dragging');
  dragStartY = e.clientY;
  dragStartTop = scrollEl.scrollTop;
  show();          // dragging is set, so this reveals without scheduling a fade
  updateBubble();
}

function onMove(e) {
  if (!dragging) return;
  e.preventDefault();
  const { max, trackH } = metrics();
  const dy = e.clientY - dragStartY;
  const deltaScroll = trackH > 0 ? (dy / trackH) * max : 0;
  scrollEl.scrollTop = clamp(dragStartTop + deltaScroll, 0, max);
  update();
  updateBubble();
}

function onUp() {
  if (!dragging) return;
  dragging = false;
  thumb.classList.remove('dragging');
  bubble.style.display = 'none';
  show();          // now that dragging stopped, arm the fade-out
}

// The section text under the thumb: the last header/label whose top has scrolled
// above the viewport top. Labels inside a windowed grid that aren't mounted are
// simply skipped — the enclosing level badge always remains as a coarse anchor.
function updateBubble() {
  const top = scrollEl.getBoundingClientRect().top;
  const heads = scrollEl.querySelectorAll('.hsk-group-header .badge, .char-grid-label');
  let label = null;
  for (const h of heads) {
    if (h.getBoundingClientRect().top - top <= 8) label = h.textContent.trim();
    else break;   // document order → the first one below the top ends it
  }
  if (!label) { bubble.style.display = 'none'; return; }
  bubble.textContent = label;
  bubble.style.display = 'block';
  const tr = thumb.getBoundingClientRect();
  bubble.style.top   = (tr.top + tr.height / 2) + 'px';
  bubble.style.right = (window.innerWidth - tr.left + 10) + 'px';
}
