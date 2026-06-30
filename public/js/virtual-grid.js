// Windowed (virtualized) renderer for the big HSK `.char-grid`s.
//
// A level like HSK7 has ~5000 tiles. Putting all of them in the DOM costs memory
// and makes every style recalc / re-render walk thousands of nodes, which is what
// makes the browser struggle. This module keeps only the rows near the viewport
// mounted; everything above and below is represented by padding on the grid so the
// scrollbar and scroll position behave exactly as if the whole grid were rendered.
//
// It deliberately keeps the existing CSS Grid layout (responsive column count via
// container queries, full-width section labels, square tiles). The only assumption
// is that every tile row is the same height (the tiles are `aspect-ratio:1`) and
// that section labels span the full width — both already true in styles.css.
//
// Usage:
//   const vg = mountVirtualGrid({ scrollEl, gridEl, cells, renderCell });
//   ...
//   vg.destroy();           // removes listeners + empties the grid
//
// `cells` is the ordered list of things to render: `{ label }` for a section
// header, anything else is a tile (passed straight to `renderCell`). `renderCell`
// returns the DOM node for one cell (a `.char-grid-label` or a `.char-tile`).

const active = new Set();

// Tear down every live instance — called by ui.js before it rebuilds the groups
// container, so the scroll/resize listeners we attached to the shared scroller
// never leak across renders.
export function destroyAllVirtualGrids() {
  for (const vg of [...active]) vg.destroy();
}

// Below this many cells the windowing overhead isn't worth it — render everything
// and let `content-visibility` handle the off-screen paint (the previous behaviour).
export const VIRTUALIZE_THRESHOLD = 400;

export function mountVirtualGrid({ scrollEl, gridEl, cells, renderCell, overscanPx = 600 }) {
  let cols = 0, gap = 0, tileH = 0, labelH = 0;
  let rows = [];          // { y, h, isLabel, start, end }  (end exclusive, into `cells`)
  let totalH = 0;
  let firstRow = -1, lastRow = -1;
  let measuredWidth = 0;
  let destroyed = false;

  // ── measurement ──────────────────────────────────────────────────────────
  // Derive column count, gap and the two row heights from the live grid. A tiny
  // probe (one tile + one label) is appended once so we read real measured
  // heights rather than guessing from CSS.
  function measure() {
    // Force the scroller into its overflowing state first. The scroller's
    // scrollbar narrows the grid, which can flip the responsive column count
    // (container query). Measuring an empty grid would see the wider, no-scrollbar
    // width and pick the wrong column count / tile size. The big padding makes the
    // scrollbar appear so we measure the same width the populated grid will have.
    gridEl.style.paddingTop = '0px';
    gridEl.style.paddingBottom = '100000px';

    const cs = getComputedStyle(gridEl);
    cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    gap  = parseFloat(cs.rowGap) || 0;
    measuredWidth = gridEl.clientWidth;

    const probeTile  = renderCell(firstTileCell());
    const probeLabel = document.createElement('div');
    probeLabel.className = 'char-grid-label';
    probeLabel.textContent = 'Mg';
    // Append a tile first so the label isn't `:first-child` (which has a smaller
    // top padding) — we want the height of a label in the middle of the grid.
    gridEl.append(probeTile, probeLabel);
    tileH  = probeTile.getBoundingClientRect().height || measuredWidth / cols;
    labelH = probeLabel.getBoundingClientRect().height || 20;
    probeTile.remove();
    probeLabel.remove();
  }

  function firstTileCell() {
    for (const c of cells) if (!c.label) return c;
    return cells[0];
  }

  // ── layout model ─────────────────────────────────────────────────────────
  // Replicate the browser's row auto-flow: tiles pack `cols` per row, a label
  // forces a fresh full-width row. Record each row's y/height so we can map a
  // scroll offset to the slice of cells that should be on screen.
  function buildRows() {
    rows = [];
    let y = 0, i = 0;
    const n = cells.length;
    while (i < n) {
      if (cells[i].label) {
        rows.push({ y, h: labelH, isLabel: true, start: i, end: i + 1 });
        y += labelH + gap;
        i += 1;
      } else {
        const start = i;
        let count = 0;
        while (i < n && !cells[i].label && count < cols) { i += 1; count += 1; }
        rows.push({ y, h: tileH, isLabel: false, start, end: i });
        y += tileH + gap;
      }
    }
    // Drop the trailing gap and keep the grid's normal 8px bottom breathing room.
    totalH = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h + 8 : 0;
  }

  // Binary-search the first row whose bottom edge is >= `top`.
  function rowAtOrAfter(top) {
    let lo = 0, hi = rows.length - 1, res = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].y + rows[mid].h >= top) { res = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return res;
  }
  function rowAtOrBefore(bottom) {
    let lo = 0, hi = rows.length - 1, res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].y <= bottom) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  }

  // ── windowing ────────────────────────────────────────────────────────────
  function render(force) {
    if (destroyed || !rows.length) return;
    const scRect   = scrollEl.getBoundingClientRect();
    const gridRect = gridEl.getBoundingClientRect();        // box top is padding-independent
    const localTop = scRect.top - gridRect.top;             // how far we've scrolled into the grid
    const visTop = localTop;
    const visBot = localTop + scRect.height;

    // Hysteresis: keep the current window while the viewport stays comfortably
    // inside it; only re-window once we scroll within ~40% of the overscan margin
    // from a rendered edge. Avoids rebuilding the DOM on every single scrolled row.
    if (!force && firstRow >= 0) {
      const haveTop = rows[firstRow].y;
      const haveBot = rows[lastRow].y + rows[lastRow].h;
      const safeTop = firstRow === 0               || (visTop - haveTop) > overscanPx * 0.4;
      const safeBot = lastRow === rows.length - 1  || (haveBot - visBot) > overscanPx * 0.4;
      if (safeTop && safeBot) return;
    }

    let r0 = rowAtOrAfter(visTop - overscanPx);
    let r1 = rowAtOrBefore(visBot + overscanPx);
    if (r0 > r1) { r0 = r1 = Math.max(0, Math.min(r0, rows.length - 1)); }
    firstRow = r0; lastRow = r1;

    const frag = document.createDocumentFragment();
    for (let r = r0; r <= r1; r++) {
      const row = rows[r];
      for (let i = row.start; i < row.end; i++) frag.appendChild(renderCell(cells[i]));
    }
    const padTop = rows[r0].y;
    const padBot = totalH - (rows[r1].y + rows[r1].h);
    gridEl.style.paddingTop    = padTop + 'px';
    gridEl.style.paddingBottom = Math.max(0, padBot) + 'px';
    gridEl.replaceChildren(frag);
  }

  // Full (re)layout: re-measure, rebuild the row model, force a fresh window.
  function relayout() {
    if (destroyed) return;
    measure();
    buildRows();
    firstRow = lastRow = -1;
    render(true);
  }

  // ── listeners ────────────────────────────────────────────────────────────
  let rafPending = false;
  const onScroll = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(false); });
  };
  scrollEl.addEventListener('scroll', onScroll, { passive: true });

  // The column count changes with width (container queries). Re-measure only when
  // the grid's width actually changes, not on every height tweak.
  const ro = new ResizeObserver(() => {
    if (destroyed) return;
    if (Math.abs(gridEl.clientWidth - measuredWidth) > 0.5) relayout();
  });
  ro.observe(gridEl);

  // `vgrid` disables the tiles' `content-visibility:auto` (see styles.css): inside
  // a window we only mount ~a screenful of tiles, all near the viewport, so they
  // must report their real height — otherwise buffered (off-screen) tiles would
  // fall back to `contain-intrinsic-size` and break the fixed row-height model.
  gridEl.classList.add('vgrid');

  const instance = {
    relayout,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scrollEl.removeEventListener('scroll', onScroll);
      ro.disconnect();
      gridEl.classList.remove('vgrid');
      gridEl.style.paddingTop = '';
      gridEl.style.paddingBottom = '';
      gridEl.replaceChildren();
      active.delete(instance);
    },
    get scrollHeight() { return totalH; },
    get debug() { return { cols, gap, tileH, labelH, totalH, rows: rows.length, measuredWidth }; },
  };
  active.add(instance);

  relayout();
  return instance;
}
