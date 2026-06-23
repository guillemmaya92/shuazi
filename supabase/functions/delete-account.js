// Supabase Edge Function: delete-account
//
// Permanently deletes the calling user's account and their data. The browser
// sends only its Supabase access token as the bearer — we verify it to identify
// the user, then use the SERVICE ROLE key to remove their rows and the auth
// user itself (which the user could not do with their own RLS-bound token).
//
// No SDK import (keeps cold-starts reliable). SUPABASE_URL and
// SUPABASE_ANON_KEY are injected automatically; add the SUPABASE_SERVICE_ROLE_KEY
// secret to the function. Deploy via the dashboard (paste this file) or the CLI
// with "Verify JWT" turned OFF so the CORS preflight reaches the handler — we
// verify the token ourselves below.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing authorization" }, 401);

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPA_URL || !ANON_KEY || !SERVICE_KEY) return json({ error: "Server not configured" }, 500);

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

  const admin = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  // Remove the user's data rows first (best-effort — keep going on individual
  // failures so a missing table never blocks the auth-user deletion).
  const tables = [
    `translations?user_id=eq.${user.id}`,
    `auth_events?user_id=eq.${user.id}`,
    `profiles?id=eq.${user.id}`,
  ];
  for (const t of tables) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/${t}`, { method: "DELETE", headers: admin });
    } catch { /* ignore — proceed to auth deletion */ }
  }

  // Delete the auth user. This is the authoritative step — fail loudly if it errors.
  const del = await fetch(`${SUPA_URL}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: admin,
  });
  if (!del.ok) {
    const detail = await del.text().catch(() => "");
    return json({ error: `Account deletion failed (${del.status})`, detail }, 500);
  }

  return json({ ok: true }, 200);
});
