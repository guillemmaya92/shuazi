#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Static SEO page generator for the Shuazi dictionary.
//
// The app itself is a single-URL client-rendered PWA, so search engines see one
// page. This script pulls the dictionary data from Supabase and emits thousands
// of static, indexable pages — one per character / word / radical, plus HSK level
// listings and a dictionary hub — each with its own <title>, meta description,
// canonical, JSON-LD and internal links. That's the surface area that ranks for
// long-tail queries like "你好 meaning" or "HSK 3 character list".
//
// Runs in CI against public/ before the Pages artifact is uploaded (see
// .github/workflows/deploy.yml). Generated files are NOT committed to the repo;
// they only live in the build output. Run it locally to preview:
//
//     node scripts/build/seo-pages.mjs
//
// If your machine intercepts TLS (corporate proxy / antivirus) and the fetch
// fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE, run with the system trust store:
//     node --use-system-ca scripts/build/seo-pages.mjs
// (Not needed in CI — the GitHub runner trusts Supabase's cert directly.)
//
// Env overrides (all optional — public anon defaults are baked in):
//     SUPA_URL, SUPA_KEY, SITE_URL
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SUPA_URL = process.env.SUPA_URL || 'https://coysmojauucqgdhhxyrz.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNveXNtb2phdXVjcWdkaGh4eXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODAxOTMsImV4cCI6MjA5Njk1NjE5M30.JO6U0TyW5gcnmJMJAvvzSh_ZiMdCKCEtRSz_N8h8adM';
const SITE = (process.env.SITE_URL || 'https://shuaziapp.com').replace(/\/$/, '');
const OUT  = 'public';
const TODAY = new Date().toISOString().slice(0, 10);

// ── Supabase REST (paginated, no SDK needed) ────────────────────────────────
async function fetchAll(table, columns, order = 'id') {
  const pageSize = 1000;
  let from = 0, all = [];
  for (;;) {
    const url = `${SUPA_URL}/rest/v1/${table}?select=${encodeURIComponent(columns)}&order=${order}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
        'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Optional table — never let a missing/locked relationship table kill the build.
async function fetchOptional(table, columns, order = 'id') {
  try { return await fetchAll(table, columns, order); }
  catch (e) { console.warn(`! ${table} skipped: ${e.message.slice(0, 120)}`); return []; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Thousands separators (1800 → "1,800").
const num = n => Number(n).toLocaleString('en-US');

// Path segment that is safe both on disk and in a URL (skip anything weird).
const pathSafe = s => typeof s === 'string' && s.length > 0 && !s.includes('/') && !s.includes('\\') && !/\s/.test(s);
const urlSeg   = s => encodeURIComponent(s);

const urls = [];                                   // collected for the sitemap
function write(relDir, html, { sitemap = true } = {}) {
  const dir = join(OUT, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  if (sitemap) urls.push('/' + relDir.split('/').map(urlSeg).join('/') + '/');
}

function shell({ title, desc, path, jsonld, body, app = false, nav = '' }) {
  const canonical = SITE + path;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<script>(function(){try{var t=localStorage.getItem('shuazi-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:image" content="${SITE}/icons/og-image.png"/>
<meta name="twitter:card" content="summary"/>
<meta name="theme-color" content="#b04030"/>
<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"/>
<link rel="stylesheet" href="/web/dict.css"/>
<script src="/web/dict.js" defer></script>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>` : ''}
</head>
<body>
<header class="site">
  <a class="brand" href="/characters/"><img class="brand-logo" src="/icons/favicon.svg" alt="Shuazi" width="34" height="34"/><span class="brand-name">Shuazi <b>App</b></span></a>
  <nav class="site-nav">
    <a href="/characters/"${nav === 'char' ? ' class="active"' : ''}>Characters</a>
    <a href="/words/"${nav === 'word' ? ' class="active"' : ''}>Words</a>
    <a href="/profile/"${nav === 'profile' ? ' class="active"' : ''}>Profile</a>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark mode">
      <svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>
    <a class="open-app" href="/">App</a>
  </nav>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-foot">
  <a class="cta" href="/"><span class="shimmer" aria-hidden="true"></span>Practice these with interactive flashcards →</a>
  <nav class="foot-links">
    <a href="/characters/">Characters</a>
    <a href="/words/">Words</a>
    <a href="/profile/">Profile</a>
  </nav>
  <p class="foot-note">刷字 Shuazi — learn Chinese Hanzi with flashcards</p>
  <p class="foot-legal"><a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a></p>
</footer>
${app ? `<script async src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js" crossorigin="anonymous" onload="window._supaReady&&window._supaReady()"></script>
<script src="/web/${app}" defer></script>` : ''}
</body>
</html>`;
}

// HSK level badge with the app's per-level colour (no link — HSK pages removed).
const hskBadge = n => `<span class="hsk-badge hsk-${n}">HSK ${n}</span>`;

// Free plan covers HSK 1–2 (same as the app). HSK 3–6 detail pages render their
// content (for SEO) but ship a lock overlay that dict-auth.js reveals for free
// users and removes for Pro.
const FREE_HSK = new Set([1, 2]);
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const gateCard = (hsk, kind = 'character') => `<div class="hsk-gate"><div class="gate-card"><span class="gate-lock">${LOCK_SVG}</span><p class="gate-msg">This is an HSK ${hsk} ${kind}</p><a class="cta gate-cta" href="/profile/"><span class="shimmer" aria-hidden="true"></span><span class="gate-txt"><span class="gate-label">Unlock with Shuazi</span> →</span></a></div></div>`;

const crumbs = items => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map((it, i) => ({
    '@type': 'ListItem', position: i + 1, name: it.name, item: SITE + it.path,
  })),
});

const hanziPath  = c => `/character/${urlSeg(c)}/`;
const wordPath   = w => `/word/${urlSeg(w)}/`;
const radPath    = r => `/radical/${urlSeg(r)}/`;
const compPath   = k => `/component/${urlSeg(k)}/`;

// Tone-stripped, space-free pinyin for searching/sorting via data-attributes.
const normPy = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');

// Light chip tiles for the interactive browsers (character + pinyin only, like
// the app's Groups grid). Search is by character/pinyin, so no meaning attr.
// No mark button — long-press cycles known/review (dict-auth.js); the state is
// shown purely with colour so unmarked tiles stay clean.
const charTile = c => `<div class="tile" data-id="${c.id}" data-type="char" data-name="${esc(c.char)}" data-py="${esc(normPy(c.pinyin))}" data-stroke="${c.stroke || 0}" data-frequency="${c.frequency || 0}"><a class="tile-link" href="${hanziPath(c.char)}"><b>${esc(c.char)}</b><span>${esc(c.pinyin ?? '')}</span></a></div>`;
const wordChip = w => {
  const len = [...w.word].length;
  const fs = len <= 1 ? '1.55rem' : len === 2 ? '1.15rem' : len === 3 ? '.86rem' : '.7rem';
  return `<div class="tile wd" data-id="${w.id}" data-type="word" data-name="${esc(w.word)}" data-py="${esc(normPy(w.pinyin))}" data-stroke="${w.stroke || 0}" data-frequency="${w.frequency || 0}"><a class="tile-link" href="${wordPath(w.word)}"><b style="font-size:${fs}">${esc(w.word)}</b><span>${esc(w.pinyin ?? '')}</span></a></div>`;
};

// Search box (toggled by the magnifier) + (optional) HSK level pills + sort.
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SORT_OPTS = [['pinyin', 'Pinyin'], ['stroke', 'Strokes'], ['frequency', 'Frequency']];
const controls = (levels = []) => `
<div class="controls">
  <div class="search-wrap" hidden>
    ${SEARCH_SVG}
    <input class="search" data-role="search" type="text" autocomplete="off" spellcheck="false" placeholder="Search by character or pinyin…" aria-label="Search the dictionary"/>
    <button class="search-clear" data-role="search-clear" type="button" aria-label="Clear search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="control-row">
    ${levels.length ? `<div class="levels" data-role="levels">${levels.map(n => `<button class="lvl-pill hsk-${n}" data-level="${n}" aria-pressed="true" type="button"><span class="lvl-h">HSK </span>${n}</button>`).join('')}</div>` : '<span></span>'}
    <div class="control-right">
      <div class="sort-dd" data-role="sort" data-value="pinyin">
        <button class="sort-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
          <svg class="sort-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h9M3 18h5"/></svg>
          <span class="sort-val">Pinyin</span>
          <svg class="sort-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <ul class="sort-menu" role="listbox">
          ${SORT_OPTS.map(([v, l]) => `<li role="option" data-value="${v}"${v === 'pinyin' ? ' class="on"' : ''}>${l}</li>`).join('')}
        </ul>
      </div>
      <button class="search-btn" data-role="search-toggle" type="button" aria-label="Toggle search">${SEARCH_SVG}</button>
    </div>
  </div>
</div>`;

// Collapsible section. `level` drives the HSK filter; `collapsed` sets initial
// state; `bar` adds a per-level progress bar (filled by dict-auth.js).
const group = (level, label, count, inner, { collapsed = false, bar = false } = {}) => `
<section class="group${collapsed ? ' collapsed' : ''}" data-level="${level}">
  <button class="group-head" type="button" aria-expanded="${!collapsed}">
    <span class="g-title">${label}</span>
    <span class="g-count">${count}</span>
    ${bar ? `<div class="g-bar"><div class="g-bar-fill hsk-${level}" style="width:0%"></div></div>` : ''}
    <svg class="g-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
  <div class="group-body">${inner}</div>
</section>`;

// ── Load everything ─────────────────────────────────────────────────────────
console.log('Fetching dictionary data from Supabase…');
const [chars, radicals, words, posTags, charWord, wordPhrase, phrases, components, componentChar] = await Promise.all([
  fetchAll('chars', 'id,char,pinyin,meaning,radical,hsk,stroke,frequency'),
  fetchAll('radicals', 'id,radical,traditional,pinyin,meaning,stroke'),
  fetchAll('words', 'id,word,pinyin,meaning,hsk,pos,stroke,frequency'),
  fetchOptional('pos_tags', 'pos,description', 'pos'),
  fetchOptional('char_word', 'id_char,id_word', 'id_char'),
  fetchOptional('word_phrase', 'id_word,id_phrase', 'id_word'),
  fetchOptional('phrases', 'id,phrase,pinyin,meaning'),
  fetchOptional('components', 'id,component,pinyin,meaning,stroke'),
  fetchOptional('component_char', 'id_component,id_char', 'id_component'),
]);
console.log(`  chars=${chars.length} words=${words.length} radicals=${radicals.length} components=${components.length}`);

// Tidy meanings: the source packs senses with bare commas — add a space after
// each so definitions read naturally ("one,single,a" → "one, single, a").
const tidy = s => typeof s === 'string' ? s.replace(/\s*,\s*/g, ', ').trim() : s;
for (const c of chars)      c.meaning = tidy(c.meaning);
for (const w of words)      w.meaning = tidy(w.meaning);
for (const r of radicals)   r.meaning = tidy(r.meaning);
for (const p of phrases)    p.meaning = tidy(p.meaning);
for (const c of components) c.meaning = tidy(c.meaning);

// Lookup maps
const posByCode    = Object.fromEntries(posTags.map(t => [t.pos, t.description]));
const radByGlyph   = Object.fromEntries(radicals.map(r => [r.radical, r]));
const charByGlyph  = Object.fromEntries(chars.map(c => [c.char, c]));
const wordById     = Object.fromEntries(words.map(w => [w.id, w]));
const phraseById   = Object.fromEntries(phrases.map(p => [p.id, p]));
const componentById = Object.fromEntries(components.map(c => [c.id, c]));
const charById      = Object.fromEntries(chars.map(c => [c.id, c]));
// char.id → [component, …]  ·  component glyph → component (representative)  ·
// component glyph → [char, …]   (aggregated by glyph so links never collide)
const componentsByCharId = {};
const compByGlyph = {};
const charsByCompGlyph = {};
for (const { id_component, id_char } of componentChar) {
  const cp = componentById[id_component];
  if (!cp || !cp.component) continue;
  (componentsByCharId[id_char] ||= []).push(cp);
  if (!compByGlyph[cp.component]) compByGlyph[cp.component] = cp;
  const ch = charById[id_char];
  if (ch) (charsByCompGlyph[cp.component] ||= []).push(ch);
}

// char.id → [word, …]  (compound words containing the character)
const wordsByCharId = {};
for (const { id_char, id_word } of charWord) {
  const w = wordById[id_word];
  if (w) (wordsByCharId[id_char] ||= []).push(w);
}
// word.id → [phrase, …]
const phrasesByWordId = {};
for (const { id_word, id_phrase } of wordPhrase) {
  const p = phraseById[id_phrase];
  if (p) (phrasesByWordId[id_word] ||= []).push(p);
}
// radical glyph → [char, …]
const charsByRadical = {};
for (const c of chars) if (c.radical) (charsByRadical[c.radical] ||= []).push(c);
// hsk level → { chars, words }
const byHsk = {};
for (const c of chars) (byHsk[c.hsk] ||= { chars: [], words: [] }).chars.push(c);
for (const w of words) (byHsk[w.hsk] ||= { chars: [], words: [] }).words.push(w);

const dl = rows => `<dl class="facts">${rows
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

const chipList = (items, href, glyphKey, pyKey) => items.length
  ? `<ul class="chips">${items.map(it =>
      `<li><a href="${href(it[glyphKey])}"><b>${esc(it[glyphKey])}</b>${
        it[pyKey] ? `<span>${esc(it[pyKey])}</span>` : ''}</a></li>`).join('')}</ul>`
  : '<p class="empty">—</p>';

// Interactive character browser (search + sort by pinyin/strokes/frequency +
// HSK level filter + collapsible level groups). dict.js wires it up.
const charBrowse = items => {
  const levels = [...new Set(items.map(c => c.hsk))].sort((a, b) => a - b);
  const groups = levels.map(n => {
    const cs = items.filter(c => c.hsk === n);
    return group(n, `HSK ${n}`, num(cs.length), `<div class="tiles chips">${cs.map(charTile).join('')}</div>`, { bar: true });
  }).join('');
  return `<div class="browse">${controls(levels)}${groups}</div>`;
};

// Interactive word list for character pages: the readable stacked phrase-cards,
// grouped by HSK, with the same controls bar (level pills + sort + search).
const wordBrowse = items => {
  const levels = [...new Set(items.map(w => w.hsk))].sort((a, b) => a - b);
  const groups = levels.map(n => {
    const ws = items.filter(w => w.hsk === n);
    const inner = `<ul class="phrases tiles">${ws.map(w =>
      `<li class="tile word-row" data-id="${w.id}" data-type="word" data-name="${esc(w.word)}" data-py="${esc(normPy(w.pinyin))}" data-stroke="${w.stroke || 0}" data-frequency="${w.frequency || 0}"><a class="tile-link" href="${wordPath(w.word)}"><span class="wr-char">${esc(w.word)}</span><span class="wr-info">${w.pinyin ? `<span class="wr-py">${esc(w.pinyin)}</span>` : ''}${w.meaning ? `<span class="wr-mn">${esc(w.meaning)}</span>` : ''}</span></a></li>`).join('')}</ul>`;
    return group(n, `HSK ${n}`, num(ws.length), inner, { bar: true });
  }).join('');
  return `<div class="browse">${controls(levels)}${groups}</div>`;
};

// ── Character pages ─────────────────────────────────────────────────────────
let nHanzi = 0;
for (const c of chars) {
  if (!pathSafe(c.char)) continue;
  const py = c.pinyin || '';
  const rad = radByGlyph[c.radical];
  const comps = (wordsByCharId[c.id] || []).filter(w => pathSafe(w.word))
    .sort((a, b) => (a.hsk - b.hsk) || ((a.frequency ?? 1e9) - (b.frequency ?? 1e9)))
    .slice(0, 48);
  const parts = [...new Map((componentsByCharId[c.id] || []).map(p => [p.component, p])).values()];
  const title = `${c.char}${py ? ` (${py})` : ''} — meaning, pinyin & stroke order · HSK ${c.hsk}`;
  const desc  = `${c.char}${py ? ` (${py})` : ''}: ${c.meaning || 'Chinese character'}. HSK ${c.hsk}${
    c.stroke ? `, ${c.stroke} strokes` : ''}${rad ? `, radical ${rad.radical}` : ''}. Example words and flashcards.`;

  const gated = !FREE_HSK.has(+c.hsk);
  const body = `
<nav class="bc"><a href="/characters/">Characters</a> › <span>${esc(c.char)}</span></nav>
<div class="gate-wrap${gated ? ' locked' : ''}"${gated ? ` data-gate="${c.hsk}"` : ''}>
<article class="hero">
  <div class="hero-glyph">${esc(c.char)}</div>
  <div class="hero-info">
    <h1>${esc(c.char)}${py ? ` <span class="py">${esc(py)}</span>` : ''}</h1>
    <p class="lead">${esc(c.meaning) || 'Chinese character'}</p>
    <div class="meta">
      ${hskBadge(c.hsk)}
      ${c.stroke ? `<span class="pill">${c.stroke} strokes</span>` : ''}
      ${rad ? `<a class="pill" href="${radPath(rad.radical)}">Radical ${esc(rad.radical)}${rad.pinyin ? ` · ${esc(rad.pinyin)}` : ''}</a>`
            : (c.radical ? `<span class="pill">Radical ${esc(c.radical)}</span>` : '')}
    </div>
  </div>
</article>
${parts.length ? `<h2>Components</h2><div class="comp-list">${parts.map(p => {
    const inner = `<b>${esc(p.component)}</b><span>${esc(p.pinyin || '')}</span>`;
    return pathSafe(p.component)
      ? `<a class="comp" href="${compPath(p.component)}" title="${esc(p.meaning || '')}">${inner}</a>`
      : `<div class="comp" title="${esc(p.meaning || '')}">${inner}</div>`;
  }).join('')}</div>` : ''}
<h2>Words with ${esc(c.char)}</h2>
${comps.length ? wordBrowse(comps) : '<p class="empty">No compound words listed.</p>'}
${gated ? gateCard(c.hsk) : ''}
</div>`;

  write(`character/${c.char}`, shell({
    app: 'dict-auth.js',
    title, desc, path: hanziPath(c.char),
    jsonld: { '@context': 'https://schema.org', '@graph': [
      { '@type': 'DefinedTerm', name: c.char, description: c.meaning || '',
        inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Shuazi Chinese Characters', url: `${SITE}/characters/` },
        url: SITE + hanziPath(c.char) },
      crumbs([{ name: 'Characters', path: '/characters/' }, { name: c.char, path: hanziPath(c.char) }]),
    ] },
    body,
  }));
  nHanzi++;
}

// ── Word pages ──────────────────────────────────────────────────────────────
const seenWord = new Set();
let nWord = 0;
for (const w of words) {
  if (!pathSafe(w.word) || seenWord.has(w.word)) continue;
  seenWord.add(w.word);
  const py = w.pinyin || '';
  const pos = posByCode[w.pos];
  const phr = (phrasesByWordId[w.id] || []).slice(0, 6);
  const title = `${w.word}${py ? ` (${py})` : ''} — meaning & pinyin · HSK ${w.hsk}`;
  const desc  = `${w.word}${py ? ` (${py})` : ''}: ${w.meaning || 'Chinese word'}. HSK ${w.hsk}${pos ? `, ${pos}` : ''}. Example sentences and flashcards.`;

  const charItems = [...w.word].map(ch => charByGlyph[ch]).filter(Boolean);
  const gated = !FREE_HSK.has(+w.hsk);
  const body = `
<nav class="bc"><a href="/words/">Words</a> › <span>${esc(w.word)}</span></nav>
<div class="gate-wrap${gated ? ' locked' : ''}"${gated ? ` data-gate="${w.hsk}"` : ''}>
<article class="hero">
  <div class="hero-glyph word">${esc(w.word)}</div>
  <div class="hero-info">
    <h1>${esc(w.word)}${py ? ` <span class="py">${esc(py)}</span>` : ''}</h1>
    <p class="lead">${esc(w.meaning) || 'Chinese word'}</p>
    <div class="meta">
      ${hskBadge(w.hsk)}
      ${pos ? `<span class="pill">${esc(pos)}</span>` : ''}
    </div>
  </div>
</article>
${charItems.length ? `<h2>Characters</h2>${chipList(charItems, hanziPath, 'char', 'pinyin')}` : ''}
${phr.length ? `<h2>Example phrases</h2><ul class="phrases">${phr.map(p =>
    `<li><div class="ph-hz">${esc(p.phrase)}</div>${p.pinyin ? `<div class="ph-py">${esc(p.pinyin)}</div>` : ''}${p.meaning ? `<div class="ph-mn">${esc(p.meaning)}</div>` : ''}</li>`).join('')}</ul>` : ''}
${gated ? gateCard(w.hsk, 'word') : ''}
</div>`;

  write(`word/${w.word}`, shell({
    app: 'dict-auth.js',
    title, desc, path: wordPath(w.word),
    jsonld: { '@context': 'https://schema.org', '@graph': [
      { '@type': 'DefinedTerm', name: w.word, description: w.meaning || '',
        inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Shuazi Chinese Vocabulary', url: `${SITE}/words/` },
        url: SITE + wordPath(w.word) },
      crumbs([{ name: 'Words', path: '/words/' }, { name: w.word, path: wordPath(w.word) }]),
    ] },
    body,
  }));
  nWord++;
}

// ── Radical pages ────────────────────────────────────────────────────────────
let nRad = 0;
for (const r of radicals) {
  if (!pathSafe(r.radical)) continue;
  const used = charsByRadical[r.radical] || [];
  const shown = used.filter(c => pathSafe(c.char)).slice(0, 300);
  const title = `Radical ${r.radical}${r.pinyin ? ` (${r.pinyin})` : ''} — meaning & characters | Shuazi`;
  const desc  = `Chinese radical ${r.radical}${r.pinyin ? ` (${r.pinyin})` : ''}: ${r.meaning || 'a Chinese radical'}${
    r.stroke ? `, ${r.stroke} strokes` : ''}. ${used.length} characters are built on it.`;
  const body = `
<nav class="bc"><a href="/characters/">Characters</a> › <span>Radical ${esc(r.radical)}</span></nav>
<article class="hero">
  <div class="hero-glyph">${esc(r.radical)}</div>
  <div class="hero-info">
    <h1>Radical ${esc(r.radical)}${r.pinyin ? ` <span class="py">${esc(r.pinyin)}</span>` : ''}</h1>
    <p class="lead">${esc(r.meaning) || 'Chinese radical'}</p>
    <div class="meta">
      ${r.stroke ? `<span class="pill">${r.stroke} strokes</span>` : ''}
      ${r.traditional && r.traditional !== r.radical ? `<span class="pill">Traditional ${esc(r.traditional)}</span>` : ''}
      <span class="pill">${num(used.length)} characters</span>
    </div>
  </div>
</article>
${shown.length ? `<h2>Characters with this radical</h2>${charBrowse(shown)}` : ''}`;

  write(`radical/${r.radical}`, shell({
    app: 'dict-auth.js',
    title, desc, path: radPath(r.radical),
    jsonld: { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: r.radical,
      description: r.meaning || '', url: SITE + radPath(r.radical) },
    body,
  }));
  nRad++;
}

// ── Component pages ──────────────────────────────────────────────────────────
let nComp = 0;
for (const glyph of Object.keys(charsByCompGlyph)) {
  if (!pathSafe(glyph)) continue;
  const cp = compByGlyph[glyph] || {};
  const used = (charsByCompGlyph[glyph] || []).filter(c => pathSafe(c.char)).slice(0, 300);
  const title = `Component ${glyph}${cp.pinyin ? ` (${cp.pinyin})` : ''} — meaning & characters | Shuazi`;
  const desc  = `Chinese component ${glyph}${cp.pinyin ? ` (${cp.pinyin})` : ''}: ${cp.meaning || 'a Chinese character component'}${
    cp.stroke ? `, ${cp.stroke} strokes` : ''}. Characters built with it.`;
  const body = `
<nav class="bc"><a href="/characters/">Characters</a> › <span>${esc(glyph)}</span></nav>
<article class="hero">
  <div class="hero-glyph">${esc(glyph)}</div>
  <div class="hero-info">
    <h1>${esc(glyph)}${cp.pinyin ? ` <span class="py">${esc(cp.pinyin)}</span>` : ''}</h1>
    <p class="lead">${esc(cp.meaning) || 'Chinese character component'}</p>
    <div class="meta">
      ${cp.stroke ? `<span class="pill">${cp.stroke} strokes</span>` : ''}
      <span class="pill">${num(used.length)} characters</span>
    </div>
  </div>
</article>
${used.length ? `<h2>Characters with this component</h2>${charBrowse(used)}` : ''}`;

  write(`component/${glyph}`, shell({
    app: 'dict-auth.js',
    title, desc, path: compPath(glyph),
    jsonld: { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: glyph,
      description: cp.meaning || '', url: SITE + compPath(glyph) },
    body,
  }));
  nComp++;
}

// ── Characters browser (/characters) ─────────────────────────────────────────
const charGroups = [1, 2, 3, 4, 5, 6].map(n => {
  const cs = (byHsk[n]?.chars || []).filter(c => pathSafe(c.char));
  if (!cs.length) return '';
  return group(n, `HSK ${n}`, num(cs.length), `<div class="tiles chips">${cs.map(charTile).join('')}</div>`, { collapsed: true, bar: true });
}).join('');

write('characters', shell({
  app: 'dict-auth.js',
  nav: 'char',
  title: 'Chinese Characters — browse, search & sort HSK 1–6 hanzi | Shuazi',
  desc: 'Search, sort and browse all HSK 1–6 Chinese characters with pinyin, meaning and stroke order. Sign in to mark what you know.',
  path: '/characters/',
  jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Shuazi Chinese Characters', url: `${SITE}/characters/` },
  body: `
<header class="prof-head">
  <h1>Characters</h1>
  <p>${num(chars.length)} characters across HSK 1–6</p>
</header>
<div class="browse">
  ${controls([1, 2, 3, 4, 5, 6])}
  <p class="mark-hint">Long-press a character to mark it <b class="k">known</b> or <b class="r">review</b>.</p>
  ${charGroups}
</div>`,
}));

// ── Dictionary: Words browser ────────────────────────────────────────────────
const wordGroups = [1, 2, 3, 4, 5, 6].map(n => {
  const ws = (byHsk[n]?.words || []).filter(w => pathSafe(w.word));
  if (!ws.length) return '';
  return group(n, `HSK ${n}`, num(ws.length), `<div class="tiles chips">${ws.map(wordChip).join('')}</div>`, { collapsed: true, bar: true });
}).join('');

write('words', shell({
  app: 'dict-auth.js',
  nav: 'word',
  title: 'Chinese Vocabulary — browse, search & sort HSK 1–6 words | Shuazi',
  desc: 'Search, sort and browse all HSK 1–6 Chinese words with pinyin and meaning. Sign in to mark what you know.',
  path: '/words/',
  jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Shuazi Chinese Vocabulary', url: `${SITE}/words/` },
  body: `
<header class="prof-head">
  <h1>Words</h1>
  <p>${num(nWord)} words across HSK 1–6</p>
</header>
<div class="browse">
  ${controls([1, 2, 3, 4, 5, 6])}
  <p class="mark-hint">Long-press a word to mark it <b class="k">known</b> or <b class="r">review</b>.</p>
  ${wordGroups}
</div>`,
}));

// ── Profile (progress + account) ─────────────────────────────────────────────
// Compact dataset for client-side stats: [id, name, hsk, frequency×1e6].
const profileData = {
  c: chars.filter(c => pathSafe(c.char)).map(c => [c.id, c.char, c.hsk, Math.round((c.frequency || 0) * 1e6)]),
  w: words.filter(w => pathSafe(w.word)).map(w => [w.id, w.word, w.hsk, Math.round((w.frequency || 0) * 1e6)]),
};

write('profile', shell({
  app: 'dict-profile.js',
  nav: 'profile',
  title: 'Your Profile — Chinese learning progress | Shuazi',
  desc: 'Track your Chinese learning progress: characters and words you know, review counts and coverage of everyday text. Sign in to sync with the Shuazi app.',
  path: '/profile/',
  jsonld: { '@context': 'https://schema.org', '@type': 'ProfilePage', name: 'Shuazi Profile', url: `${SITE}/profile/` },
  body: `
<header class="prof-head">
  <h1>Profile</h1>
  <p>Your progress overview</p>
</header>

<section class="prof-card">
  <h2>Game</h2>
  <div class="game-pills" id="gamePills">
    <button class="game-pill on" data-game="characters" type="button">Characters</button>
    <button class="game-pill" data-game="words" type="button">Words</button>
  </div>
</section>

<section class="prof-card">
  <h2>Progress</h2>
  <div id="progRoot"><p class="empty">Loading…</p></div>
</section>

<section class="prof-card pro-card" id="proBox" hidden></section>

<section class="prof-card">
  <h2>Account</h2>
  <div id="accountBox"><p class="empty">Loading…</p></div>
</section>

<script>window.__SHUAZI_DATA__=${JSON.stringify(profileData)}</script>`,
}), { sitemap: false });

// ── Sitemap(s) ──────────────────────────────────────────────────────────────
// /characters/ and /words/ are already in `urls` via write(); only the
// hand-maintained static pages need adding here.
const allUrls = ['/', '/privacy.html', '/terms.html', ...urls];
const entry = u => `  <url><loc>${SITE}${u}</loc><lastmod>${TODAY}</lastmod></url>`;
const CHUNK = 45000;

if (allUrls.length <= CHUNK) {
  writeFileSync(join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${allUrls.map(entry).join('\n')}\n</urlset>\n`);
} else {
  const parts = [];
  for (let i = 0; i < allUrls.length; i += CHUNK) parts.push(allUrls.slice(i, i + CHUNK));
  parts.forEach((part, i) => {
    writeFileSync(join(OUT, `sitemap-${i + 1}.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${part.map(entry).join('\n')}\n</urlset>\n`);
  });
  writeFileSync(join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      parts.map((_, i) => `  <sitemap><loc>${SITE}/sitemap-${i + 1}.xml</loc><lastmod>${TODAY}</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`);
}

console.log(`Generated ${nHanzi} hanzi + ${nWord} word pages, /characters, /words, /profile. Sitemap: ${allUrls.length} URLs.`);
