// Supabase Edge Function: check-account
//
// Given an email, reports whether an account exists, whether it has a password,
// and which auth providers it uses — so the "forgot password" screen can point
// Google-only users to Google and tell users when no account exists.
//
// Public / pre-auth (no user token). It calls the SECURITY DEFINER SQL function
// public.account_lookup with the SERVICE ROLE key. Deploy with "Verify JWT" OFF
// so the request reaches the handler; add the SUPABASE_SERVICE_ROLE_KEY secret.
//
// ⚠️ This intentionally exposes account existence (email enumeration) for UX.

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

  let email;
  try {
    ({ email } = await req.json());
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return json({ error: "Valid email required" }, 400);
  }

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPA_URL || !SERVICE_KEY) return json({ error: "Server not configured" }, 500);

  let rows;
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/rpc/account_lookup`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_email: email }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ error: `Lookup failed (${res.status})`, detail }, 502);
    }
    rows = await res.json();
  } catch (e) {
    return json({ error: "Lookup failed", detail: String(e) }, 502);
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  return json({
    exists: !!row,
    hasPassword: !!row?.has_password,
    providers: row?.providers ?? [],
  });
});
