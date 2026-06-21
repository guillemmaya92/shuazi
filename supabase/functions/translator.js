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

// Strict JSON Schema — the model is forced to return exactly this shape.
const SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "translation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        translation: { type: "string" },
        tokens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              zh: { type: "string" },
              en: { type: "string" },
            },
            required: ["zh", "en"],
            additionalProperties: false,
          },
        },
      },
      required: ["translation", "tokens"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT =
  "You are a professional translator. Translate the user message into Simplified Chinese, then segment the translation into natural word-level tokens. " +
  'Reply with ONLY a JSON object of the form {"translation": string, "tokens": [{"zh": string, "en": string}]} where ' +
  '"translation" is the full Simplified Chinese translation, and "tokens" is that translation split into words in order. ' +
  'For each token, "zh" is the Chinese word (or punctuation mark) and "en" is a short literal English gloss for it in this context — ideally 1 word, at most 2; no articles, no slashes or alternatives, just the single best meaning (use an empty string for punctuation). ' +
  "No pinyin, no extra keys, no explanations.";

// Calls OpenRouter with the given response format. `requireParams` only routes
// to providers that honour every parameter (used for the strict-schema attempt).
function callOpenRouter(key, text, responseFormat, requireParams) {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: responseFormat,
      ...(requireParams ? { provider: { require_parameters: true } } : {}),
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
    // Preferred path: strict JSON Schema, restricted to providers that honour
    // it. If that fails (e.g. no such provider available), fall back to basic
    // JSON mode — parseModelJson then handles any imperfect formatting.
    resp = await callOpenRouter(key, text, SCHEMA, true);
    if (!resp.ok) {
      resp = await callOpenRouter(key, text, { type: "json_object" }, false);
    }
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

  // The model is asked for JSON, but sometimes wraps it in a ```json fence or
  // adds stray text around it. Extract the JSON object before parsing, and
  // degrade gracefully to the raw text if it still isn't parseable.
  let translation = content;
  let tokens = null;
  const parsed = parseModelJson(content);
  if (parsed) {
    if (typeof parsed.translation === "string" && parsed.translation.trim()) {
      translation = parsed.translation.trim();
    }
    if (Array.isArray(parsed.tokens)) {
      tokens = parsed.tokens
        .filter((t) => t && typeof t.zh === "string" && t.zh.length)
        .map((t) => ({ zh: t.zh, en: typeof t.en === "string" ? t.en.trim() : "" }));
    }
  }
  if (!translation) return json({ error: "Empty translation" }, 502);

  return json({ translation, tokens }, 200);
});