// Supabase Edge Function: profile-sync
//
// Captures per-user info on sign-in and upserts it into `profiles`. The country
// is resolved SERVER-SIDE from the request (Cloudflare's country header, or an
// IP lookup as a fallback) so the browser never calls a geo service and the
// user's IP isn't exposed to a third party from the client.
//
// The browser sends only the locally-derived hints (locale, languages,
// timezone, platform) plus its Supabase access token as the bearer. We use that
// token both to identify the user and for the REST upsert, so it obeys the
// profiles RLS policies. No SDK import (keeps cold-starts reliable); no extra
// secrets — SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.
//
// Deploy via the dashboard (paste this file) or the CLI. Turn OFF "Verify JWT"
// so the browser's CORS preflight reaches the handler — we verify the token
// ourselves below.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Resolves the caller's IP, 2-letter country and city. Country prefers the edge
// header (Cloudflare in front of Supabase); city always comes from an IP lookup.
async function resolveGeo(req) {
  const h = req.headers;
  const ip = (h.get("x-forwarded-for") || h.get("x-real-ip") || "").split(",")[0].trim() || null;

  let country = (h.get("cf-ipcountry") || h.get("x-vercel-ip-country") || h.get("x-country") || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === "XX" || country === "T1") country = null;
  let city = null;

  if (ip) {
    // Primary: ipwho.is (free, no key) — gives country + city in one call.
    try {
      const r = await fetch(`https://ipwho.is/${ip}?fields=success,country_code,city`);
      const j = await r.json();
      if (j?.success) {
        if (!country && /^[A-Z]{2}$/.test(j.country_code || "")) country = j.country_code;
        if (j.city) city = j.city;
      }
    } catch { /* ignore */ }
    // Fallback: ipapi.co.
    if (!country || !city) {
      try {
        const r = await fetch(`https://ipapi.co/${ip}/json/`, { headers: { "User-Agent": "shuazi-edge" } });
        const j = await r.json();
        if (!country && /^[A-Z]{2}$/.test(j.country_code || "")) country = j.country_code;
        if (!city && j.city) city = j.city;
      } catch { /* ignore */ }
    }
  }
  return { ip, country, city };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing authorization" }, 401);

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPA_URL || !ANON_KEY) return json({ error: "Server not configured" }, 500);

  // Identify the user from their JWT.
  let user;
  try {
    const ures = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    });
    if (!ures.ok) return json({ error: "Invalid session" }, 401);
    user = await ures.json();
  } catch (e) {
    return json({ error: "Auth lookup failed", detail: String(e) }, 502);
  }
  if (!user?.id) return json({ error: "Invalid session" }, 401);

  let body = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const { locale, languages, timezone, platform } = body || {};

  const { ip, country, city } = await resolveGeo(req);
  const userAgent = req.headers.get("user-agent") || null;
  const meta = user.user_metadata || {};

  const row = {
    id:         user.id,
    email:      user.email ?? null,
    full_name:  meta.full_name ?? meta.name ?? null,
    avatar_url: meta.avatar_url ?? meta.picture ?? null,
    country,
    locale:     typeof locale === "string" ? locale : null,
    languages:  typeof languages === "string" ? languages : null,
    timezone:   typeof timezone === "string" ? timezone : null,
    platform:   platform === "mobile" || platform === "desktop" ? platform : null,
    last_login: new Date().toISOString(),
  };

  // Upsert the profile via PostgREST as the user (respects RLS). on_conflict=id merges.
  const up = await fetch(`${SUPA_URL}/rest/v1/profiles?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!up.ok) {
    const detail = await up.text().catch(() => "");
    return json({ error: `Upsert failed (${up.status})`, detail }, 500);
  }

  // Append an audit event (best-effort — never block the response on it).
  try {
    await fetch(`${SUPA_URL}/rest/v1/auth_events`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: user.id, event: "sign_in", ip, country, city, user_agent: userAgent,
      }),
    });
  } catch { /* ignore audit failures */ }

  return json({ ok: true, country, city }, 200);
});
