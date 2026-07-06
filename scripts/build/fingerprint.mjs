#!/usr/bin/env node
// Cache-busting for the GitHub Pages deploy.
//
// Cloudflare caches CSS/JS in front of Pages with a 1-year TTL, so a new deploy
// isn't visible until those URLs change. This appends ?b=<build-id> to every
// same-origin CSS/JS reference (HTML tags, ES module imports and the service
// worker registration) so each deploy produces fresh URLs — Cloudflare keeps
// caching each version forever, and no purge is ever needed.
//
// The HTML itself is served DYNAMIC (not edge-cached), so the new ?b= references
// reach visitors immediately. Runs in CI against public/ before the artifact is
// uploaded; source files in the repo stay unversioned (local dev is unaffected).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BUILD = (process.argv[2] || 'dev').slice(0, 12);
const ROOT = 'public';

const tag = url => (url.includes('?b=') ? url : `${url}?b=${BUILD}`);

// 1. app.html (the app shell) — stylesheet / modulepreload / script references.
// index.html is now the marketing landing page and has no app.js/styles.css refs.
const htmlPath = join(ROOT, 'app.html');
const html = readFileSync(htmlPath, 'utf8').replace(
  /(href|src)="(\.\/(?:app\.js|styles\.css|js\/[\w-]+\.js))"/g,
  (_, attr, url) => `${attr}="${tag(url)}"`,
);
writeFileSync(htmlPath, html);

// 2. JS modules — relative import specifiers + the service-worker registration
const jsFiles = ['app.js', ...readdirSync(join(ROOT, 'js')).map(f => `js/${f}`)]
  .filter(f => f.endsWith('.js'));
for (const rel of jsFiles) {
  const path = join(ROOT, rel);
  const src = readFileSync(path, 'utf8')
    .replace(/from\s+'(\.\.?\/[^']+\.js)'/g, (_, u) => `from '${tag(u)}'`)
    .replace(/register\('(\.\/sw\.js)'\)/g, (_, u) => `register('${tag(u)}')`);
  writeFileSync(path, src);
}

console.log(`Fingerprinted CSS/JS with build id b=${BUILD}`);
