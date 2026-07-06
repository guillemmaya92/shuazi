# app.shuaziapp.com via Cloudflare Worker

This repo now serves two things from the same GitHub Pages deployment:

- `public/index.html` — the marketing landing page (root, `shuaziapp.com`)
- `public/app.html` — the actual app (was `index.html` before)

GitHub Pages only accepts **one** custom domain per repo (`shuaziapp.com`,
from `public/CNAME` — unchanged). To get `app.shuaziapp.com` to show the app,
[`app-subdomain-worker.js`](./app-subdomain-worker.js) reverse-proxies that
subdomain to this same deployment, serving `app.html` at the root and passing
every other path through unchanged (JS, CSS, manifest, icons, `privacy.html`,
`terms.html`, `汉字雨.html`, ...).

## One-time setup (Cloudflare dashboard — I can't do this part for you)

1. **DNS** — Cloudflare → DNS → add a record:
   - Type: `CNAME`, Name: `app`, Target: `shuaziapp.com` (or `guillemmaya92.github.io`)
   - Proxy status: **Proxied** (orange cloud) — required, Workers only run on proxied traffic.

2. **Worker** — Cloudflare → Workers & Pages → Create → paste in
   [`app-subdomain-worker.js`](./app-subdomain-worker.js) → Deploy.

3. **Route** — on that Worker → Settings → Triggers → Add route:
   - Route: `app.shuaziapp.com/*`
   - Zone: `shuaziapp.com`

4. **SSL/TLS** — make sure the zone's SSL mode is "Full" or "Full (strict)" so
   `app.shuaziapp.com` gets a valid certificate (Cloudflare issues this
   automatically for proxied records).

## Also needed: allow the new origin in Supabase

The app calls `supa.auth.signInWithOAuth`, `resetPasswordForEmail`, etc. with
`redirectTo: window.location.href` — this will automatically become
`app.shuaziapp.com` once the app loads from there, but Supabase will **reject**
the redirect unless the domain is allow-listed:

- Supabase dashboard → Authentication → URL Configuration → **Redirect URLs**
  → add `https://app.shuaziapp.com/**`
- (Leave `https://shuaziapp.com/**` there too if it's already listed, doesn't hurt.)

Google OAuth's redirect URI is Supabase's own callback
(`https://<project>.supabase.co/auth/v1/callback`), not shuaziapp.com, so no
change needed there — but double check the Google Cloud Console OAuth
client's "Authorized JavaScript origins" if it's restricted to a specific
domain list.

## Verify after DNS propagates

- `https://app.shuaziapp.com/` → loads the app (flashcards deck)
- `https://app.shuaziapp.com/manifest.json` → returns the JSON manifest
- `https://app.shuaziapp.com/privacy.html` → loads (shared static page)
- Sign in with Google from `app.shuaziapp.com` → completes without a Supabase
  "redirect URL not allowed" error
- `https://shuaziapp.com/` → still loads the landing page, untouched
