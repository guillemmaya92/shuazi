// Supabase Edge Function: translator
//
// Proxies translation requests to DeepSeek via OpenRouter, keeping the
// OpenRouter API key as a server-side secret (never shipped to the browser).
//
// Deploy via the Supabase dashboard (paste this file's contents), or with the
// CLI after placing it at supabase/functions/translator/index.ts.
// Secret:  OPENROUTER_API_KEY=sk-or-v1-...
//
// The browser calls this with the public Supabase anon key as the bearer token
// (same as any other Edge Function). The real OpenRouter key lives only here.

const MODEL = "deepseek/deepseek-chat";
const MAX_CHARS = 2000;

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

  let text;
  try {
    ({ text } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof text !== "string" || !text.trim()) {
    return json({ error: 'Missing "text"' }, 400);
  }
  if (text.length > MAX_CHARS) {
    return json({ error: `Text too long (max ${MAX_CHARS} chars)` }, 413);
  }

  const key = Deno.env.get("OPENROUTER_API_KEY")?.trim();
  if (!key) return json({ error: "Server not configured" }, 500);

  let resp;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a professional translator. Translate the user message into Simplified Chinese. Reply with ONLY the translation — no pinyin, no quotes, no explanations.",
          },
          { role: "user", content: text },
        ],
      }),
    });
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return json({ error: `OpenRouter ${resp.status}`, detail }, 502);
  }

  const data = await resp.json();
  const translation = data?.choices?.[0]?.message?.content?.trim();
  if (!translation) return json({ error: "Empty translation" }, 502);

  return json({ translation }, 200);
});
