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

// Compact output keeps generated tokens (and therefore latency) low: the model
// returns just an array of [word, gloss] pairs — the full translation is
// reconstructed by joining the words, so it's never emitted twice.
const SYSTEM_PROMPT =
  "You are a professional translator. Translate the user message into Simplified Chinese, then segment it into natural word-level tokens. " +
  'Reply with ONLY a compact JSON object {"t": [[zh, en], ...]} — an array of [word, gloss] pairs in order. ' +
  'Each "zh" is one Chinese word (or punctuation mark); each "en" is a short literal English gloss for it in context — ideally 1 word, at most 2; no articles, no slashes or alternatives, just the single best meaning (empty string for punctuation). ' +
  "No translation field, no pinyin, no extra keys, no explanations.";

// Calls OpenRouter. Uses plain JSON mode (fast — parseModelJson tolerates any
// imperfect formatting) and routes to the highest-throughput provider.
function callOpenRouter(key, text) {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      provider: { sort: "throughput" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Extracts and parses the JSON object from a model reply that may be wrapped in
// a ```json code fence or padded with stray text. Returns the parsed object, or
// null if nothing parseable is found.
function parseModelJson(content) {
  // Strip a leading/trailing markdown code fence if present.
  let s = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // Fall back to the outermost { ... } block anywhere in the text.
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        /* give up */
      }
    }
    return null;
  }
}

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
    resp = await callOpenRouter(key, text);
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return json({ error: `OpenRouter ${resp.status}`, detail }, 502);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) return json({ error: "Empty translation" }, 502);

  // Expand the compact pairs into { zh, en } tokens and rebuild the full
  // translation by joining the words. Accepts the legacy object shape too, and
  // degrades to the raw reply if nothing parseable comes back.
  let translation = "";
  let tokens = null;
  const parsed = parseModelJson(content);
  const pairs = Array.isArray(parsed?.t) ? parsed.t
    : Array.isArray(parsed?.tokens) ? parsed.tokens
    : null;
  if (pairs) {
    tokens = pairs
      .map((p) => (Array.isArray(p) ? { zh: p[0], en: p[1] } : p))
      .filter((t) => t && typeof t.zh === "string" && t.zh.length)
      .map((t) => ({ zh: t.zh, en: typeof t.en === "string" ? t.en.trim() : "" }));
    translation = tokens.map((t) => t.zh).join("");
  }
  if (!translation) {
    // Couldn't parse tokens — use any translation field, else the raw reply.
    translation = typeof parsed?.translation === "string" && parsed.translation.trim()
      ? parsed.translation.trim()
      : content;
    tokens = null;
  }
  if (!translation) return json({ error: "Empty translation" }, 502);

  return json({ translation, tokens }, 200);
});