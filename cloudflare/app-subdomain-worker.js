// Cloudflare Worker: serves app.shuaziapp.com from this same repo's GitHub
// Pages deployment, without needing a second custom domain on GitHub's side
// (GitHub Pages only supports one custom domain per repo — shuaziapp.com).
//
// How it works: every request to app.shuaziapp.com is reverse-proxied to the
// project's github.io URL (which always works, regardless of the custom
// domain configured in GitHub's Pages settings). The root path ("/" or
// "/index.html") is rewritten to "/app.html" — the app shell — while every
// other path (styles.css, js/*, manifest.json, icons/*, privacy.html,
// terms.html, 汉字雨.html...) passes through unchanged, since those files are
// shared identically between the marketing site and the app.
//
// The browser's address bar always shows app.shuaziapp.com — only the
// server-to-server fetch target changes.

const GH_PAGES_ORIGIN = 'https://guillemmaya92.github.io/shuazi';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === '/' || path === '/index.html') path = '/app.html';

    const target = GH_PAGES_ORIGIN + path + url.search;
    const upstream = await fetch(target, {
      headers: request.headers,
      redirect: 'follow',
    });

    // Clone so we can freely return it (upstream responses from fetch() are
    // otherwise immutable in some edge cases when re-wrapped).
    return new Response(upstream.body, upstream);
  },
};
