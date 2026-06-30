// Floating jump rail for the long HSK grids.
//
// It reads the sticky section headers (`.grid-section-head`) that ui.js renders
// into the open grids and builds a tappable index pinned to the right edge of
// the groups scroll area — like the A–Z rail in Contacts. Tapping or dragging a
// letter scrolls to that section; the active letter tracks the scroll position.
//
// The module owns its own DOM (created lazily on <body>) and is fully driven by
// `refreshGridRail()`, which ui.js calls after every render / expand / collapse
// and on tab switches. It hides itself whenever the Groups screen isn't active
// or there are fewer than two visible sections.

let rail, bubble, scrollEl;
let dots = [];
let rafPending = false;

export function refreshGridRail() {
  scrollEl = document.getElementById('groups-scroll');
  const screen = document.getElementById('screen-groups');
  if (!scrollEl || !screen || !screen.classList.contains('active')) { hide(); return; }

  ensureEls();

  // Only headers inside an expanded grid count (collapsed wraps keep their
  // headers in the DOM but at zero height).
  const heads = [...scrollEl.querySelectorAll('.char-grid-wrap:not(.collapsed) .grid-section-head')];
  if (heads.length < 2) { hide(); return; }

  buildDots(heads);
  position();
  rail.style.display = 'flex';
  updateActive();
}

function hide() {
  if (rail)   rail.style.display = 'none';
  if (bubble) bubble.style.display = 'none';
}

function ensureEls() {
  if (rail) return;

  rail = document.createElement('div');
  rail.id = 'gridRail';
  rail.setAttribute('aria-hidden', 'true');

  bubble = document.createElement('div');
  bubble.id = 'gridRailBubble';

  document.body.appendChild(rail);
  document.body.appendChild(bubble);

  const onScrub = (e) => {
    const dot = dotAtY(e.clientY);
    if (dot) jumpTo(dot, true);
  };
  rail.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rail.setPointerCapture?.(e.pointerId);
    rail.classList.add('scrubbing');
    onScrub(e);
  });
  rail.addEventListener('pointermove', (e) => { if (rail.classList.contains('scrubbing')) onScrub(e); });
  const end = () => { rail.classList.remove('scrubbing'); if (bubble) bubble.style.display = 'none'; };
  rail.addEventListener('pointerup', end);
  rail.addEventListener('pointercancel', end);

  scrollEl.addEventListener('scroll', () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; updateActive(); });
  }, { passive: true });

  window.addEventListener('resize', () => { if (rail.style.display !== 'none') position(); });
}

function buildDots(heads) {
  rail.innerHTML = '';
  dots = heads.map(head => {
    const d = document.createElement('div');
    d.className = 'rail-dot';
    d.textContent = head.dataset.rail || head.dataset.key || '·';
    d._head = head;
    rail.appendChild(d);
    return d;
  });
}

// Pin the rail (position:fixed) against the right edge of the scroll area.
function position() {
  const r = scrollEl.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) { hide(); return; }
  rail.style.top    = r.top + 'px';
  rail.style.height = r.height + 'px';
  rail.style.right  = Math.max(0, window.innerWidth - r.right) + 'px';
}

function dotAtY(y) {
  let best = null, bestDist = Infinity;
  for (const d of dots) {
    const rr = d.getBoundingClientRect();
    if (y >= rr.top && y <= rr.bottom) return d;
    const dist = Math.abs(rr.top + rr.height / 2 - y);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}

function jumpTo(dot, showLabel) {
  const head = dot._head;
  const sr = scrollEl.getBoundingClientRect();
  const hr = head.getBoundingClientRect();
  scrollEl.scrollTop += (hr.top - sr.top) - 4;   // align section head to the top
  setActive(dot);
  if (showLabel) showBubble(dot);
}

function showBubble(dot) {
  bubble.textContent = dot._head.textContent;
  bubble.style.display = 'block';
  const rr = dot.getBoundingClientRect();
  const railR = rail.getBoundingClientRect();
  bubble.style.top   = (rr.top + rr.height / 2) + 'px';
  bubble.style.right = (window.innerWidth - railR.left + 10) + 'px';
}

function updateActive() {
  if (!dots.length || rail.style.display === 'none') return;
  const srTop = scrollEl.getBoundingClientRect().top;
  let active = dots[0];
  for (const d of dots) {
    if (d._head.getBoundingClientRect().top - srTop <= 8) active = d;
    else break;   // heads are in document order, so the first one below the top ends it
  }
  setActive(active);
}

function setActive(dot) {
  for (const d of dots) d.classList.toggle('active', d === dot);
}
