/* Progressive enhancement for the dictionary pages: live search, sort dropdown,
   HSK level filters and collapsible groups — all over server-rendered content,
   so search engines still see the full page. */
(() => {
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Dark / light toggle (shares the 'shuazi-theme' key with the app)
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('shuazi-theme', next); } catch (e) {}
  });

  // Close any open sort dropdown on outside click / Escape
  const closeSorts = () => document.querySelectorAll('.sort-dd.open').forEach(d => {
    d.classList.remove('open');
    d.querySelector('.sort-btn')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', closeSorts);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSorts(); });

  document.querySelectorAll('.browse').forEach(init);

  function init(root) {
    const search    = root.querySelector('[data-role="search"]');
    const sortDD    = root.querySelector('[data-role="sort"]');
    const levelBtns = [...root.querySelectorAll('[data-role="levels"] [data-level]')];
    const groups    = [...root.querySelectorAll('.group')];
    const activeLevels = new Set(levelBtns.map(b => b.dataset.level));
    // Remember each group's initial open/closed state so we can restore it when
    // the search is cleared (searching force-opens matching groups).
    const initialCollapsed = new Map(groups.map(g => [g, g.classList.contains('collapsed')]));

    // Magnifier: show/hide the search field
    const searchToggle = root.querySelector('[data-role="search-toggle"]');
    const searchWrap   = root.querySelector('.search-wrap');
    const searchClear  = root.querySelector('[data-role="search-clear"]');
    const syncClear = () => searchClear?.classList.toggle('show', !!(search && search.value));
    searchToggle?.addEventListener('click', () => {
      const show = searchWrap.hidden;
      searchWrap.hidden = !show;
      searchToggle.classList.toggle('on', show);
      if (show) { search?.focus(); }
      else if (search) { search.value = ''; apply(); }
      syncClear();
    });
    searchClear?.addEventListener('click', () => {
      if (!search) return;
      search.value = ''; apply(); syncClear(); search.focus();
    });

    // Collapsible sections
    groups.forEach(g => {
      const head = g.querySelector('.group-head');
      head?.addEventListener('click', () => {
        const collapsed = g.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
      });
    });

    // Level filter pills
    levelBtns.forEach(b => b.addEventListener('click', () => {
      const lv = b.dataset.level;
      const on = !activeLevels.has(lv);
      on ? activeLevels.add(lv) : activeLevels.delete(lv);
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('off', !on);
      apply();
    }));

    // Custom sort dropdown (glass menu)
    const sortBtn = sortDD?.querySelector('.sort-btn');
    sortBtn?.addEventListener('click', e => {
      e.stopPropagation();
      const open = sortDD.classList.toggle('open');
      sortBtn.setAttribute('aria-expanded', String(open));
    });
    sortDD?.querySelectorAll('.sort-menu li').forEach(li => li.addEventListener('click', () => {
      sortDD.dataset.value = li.dataset.value;
      sortDD.querySelector('.sort-val').textContent = li.textContent;
      sortDD.querySelectorAll('li').forEach(x => x.classList.toggle('on', x === li));
      sortDD.classList.remove('open');
      sortBtn.setAttribute('aria-expanded', 'false');
      sort();
    }));

    search?.addEventListener('input', () => { apply(); syncClear(); });

    function sort() {
      const key = sortDD ? sortDD.dataset.value : 'pinyin';
      groups.forEach(g => {
        const box = g.querySelector('.tiles');
        if (!box) return;
        [...box.children]
          .sort((a, b) => {
            if (key === 'stroke')   return (+a.dataset.stroke   || 0) - (+b.dataset.stroke   || 0) || cmpPy(a, b);
            if (key === 'frequency') return (+b.dataset.frequency || 0) - (+a.dataset.frequency || 0) || cmpPy(a, b);
            return cmpPy(a, b);
          })
          .forEach(t => box.appendChild(t));
      });
    }
    const cmpPy = (a, b) => (a.dataset.py || '').localeCompare(b.dataset.py || '');

    function apply() {
      const term = norm(search ? search.value.trim() : '').replace(/\s+/g, '');
      const raw  = (search ? search.value.trim() : '').toLowerCase();
      groups.forEach(g => {
        const levelOn = !levelBtns.length || activeLevels.has(g.dataset.level);
        let visible = 0;
        g.querySelectorAll('.tile').forEach(t => {
          const hit = !term
            || t.dataset.name.includes(raw)
            || (t.dataset.py || '').includes(term);
          t.style.display = hit ? '' : 'none';
          if (hit) visible++;
        });
        g.style.display = (levelOn && visible) ? '' : 'none';
        if (term) { g.classList.remove('collapsed'); g.querySelector('.group-head')?.setAttribute('aria-expanded', 'true'); }
        else {
          const wasCollapsed = initialCollapsed.get(g);
          g.classList.toggle('collapsed', wasCollapsed);
          g.querySelector('.group-head')?.setAttribute('aria-expanded', String(!wasCollapsed));
        }
      });
    }

    sort();
  }
})();
