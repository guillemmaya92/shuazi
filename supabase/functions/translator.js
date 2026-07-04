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

const MODEL = "deepseek/deepseek-v4-flash";
const MAX_CHARS = 2000;
const MAX_TOKENS = 4000;
const MAX_RETRIES = 2; // retries on transient upstream errors (429/5xx)

// Supported output languages. Chinese ("zh") is the rich mode (tokenized with
// per-word glosses); the others return a plain translation only.
const LANGS = { zh: "Simplified Chinese", en: "English", es: "Spanish" };

// The language the per-word glosses are written in (the app's UI language).
const GLOSS_LANGS = { en: "English", es: "Spanish" };

// Chinese mode. Compact output keeps generated tokens (and therefore latency)
// low: the model returns just an array of [word, gloss] pairs — the full
// translation is reconstructed by joining the words, so it's never emitted twice.
// The exact JSON shape is enforced by TOKENS_SCHEMA (json_schema strict mode)
// rather than by prompting alone, so the prompt only needs to describe the
// translation/segmentation/gloss rules. The gloss is written in `glossName`
// (the app's selected language).
const zhPrompt = (glossName) =>
  `You are a professional translator. Every "gloss" you output MUST be written in ${glossName} — never in English or any other language (unless ${glossName} is English). ` +
  "Translate the user message into Simplified Chinese, then segment it into natural word-level tokens. " +
  `For each token: "zh" is one Chinese word (or punctuation mark); "gloss" is that word's short literal meaning in ${glossName} — ideally 1 word, at most 2; no articles, no slashes or alternatives, just the single best meaning (empty string for punctuation). ` +
  "No pinyin, no explanations.";

// Plain mode (any non-Chinese target): just the translation, no tokens/glosses.
const plainPrompt = (langName) =>
  `You are a professional translator. Translate the user message into ${langName}. ` +
  "Return just the translated text — no explanations, no notes, no alternatives.";

// Strict JSON Schema for response_format: structured outputs. Pairs are objects
// ({zh, gloss}) rather than 2-element tuples, since fixed-length tuple arrays
// aren't reliably validated by every provider's strict-mode implementation —
// objects with required/additionalProperties:false are. `gloss` is language-neutral
// (its language is whatever the app requested), unlike the old `en` field name.
const TOKENS_SCHEMA = {
  name: "translation_tokens",
  strict: true,
  schema: {
    type: "object",
    properties: {
      t: {
        type: "array",
        items: {
          type: "object",
          properties: {
            zh: { type: "string" },
            gloss: { type: "string" },
          },
          required: ["zh", "gloss"],
          additionalProperties: false,
        },
      },
    },
    required: ["t"],
    additionalProperties: false,
  },
};

// Strict JSON Schema for the plain (non-Chinese) response: a single string.
const PLAIN_SCHEMA = {
  name: "translation",
  strict: true,
  schema: {
    type: "object",
    properties: { translation: { type: "string" } },
    required: ["translation"],
    additionalProperties: false,
  },
};

// Calls OpenRouter with the given system prompt and strict response schema, and
// routes to the highest-throughput provider that supports the parameters.
// reasoning is explicitly disabled: DeepSeek V4 Flash defaults to "thinking
// mode" on, which (a) can push the actual answer into a separate reasoning
// field instead of message.content, leaving content empty, and (b) eats into
// the token budget, truncating the JSON on longer inputs. max_tokens is set
// explicitly for the same reason — without it, truncation on longer texts
// silently produces broken JSON.
function callOpenRouter(key, text, system, schema) {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      reasoning: { enabled: false },
      response_format: { type: "json_schema", json_schema: schema },
      provider: { sort: "throughput", require_parameters: true },
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    }),
  });
}

// Wraps callOpenRouter with a couple of retries on transient failures
// (network errors, 429 rate limit, 5xx from the provider). Non-transient
// errors (4xx other than 429) are returned immediately without retrying.
async function callOpenRouterWithRetry(key, text, system, schema) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await callOpenRouter(key, text, system, schema);
      if (resp.ok) return resp;
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`OpenRouter ${resp.status}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
      }
      return resp; // non-retriable error status, return as-is
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr;
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

  let text, target, gloss;
  try {
    ({ text, target, gloss } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof text !== "string" || !text.trim()) {
    return json({ error: 'Missing "text"' }, 400);
  }
  if (text.length > MAX_CHARS) {
    return json({ error: `Text too long (max ${MAX_CHARS} chars)` }, 413);
  }
  // Default to Chinese for older clients that don't send a target; glosses default
  // to English if the client doesn't specify (or sends an unsupported language).
  target = typeof target === "string" && LANGS[target] ? target : "zh";
  gloss = typeof gloss === "string" && GLOSS_LANGS[gloss] ? gloss : "en";
  const isZh = target === "zh";
  const system = isZh ? zhPrompt(GLOSS_LANGS[gloss]) : plainPrompt(LANGS[target]);
  const schema = isZh ? TOKENS_SCHEMA : PLAIN_SCHEMA;

  const key = Deno.env.get("OPENROUTER_API_KEY")?.trim();
  if (!key) return json({ error: "Server not configured" }, 500);

  let resp;
  try {
    resp = await callOpenRouterWithRetry(key, text, system, schema);
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return json({ error: `OpenRouter ${resp.status}`, detail }, 502);
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    // Surface finish_reason so logs tell you why: "length" = truncated by
    // max_tokens, anything else = model genuinely returned nothing.
    console.error("Empty content from OpenRouter", {
      finish_reason: choice?.finish_reason,
      choice,
    });
    return json(
      { error: "Empty translation", finish_reason: choice?.finish_reason },
      502,
    );
  }

  const parsed = parseModelJson(content);

  // Non-Chinese targets: plain translation, no tokens.
  if (!isZh) {
    const out = (typeof parsed?.translation === "string" && parsed.translation.trim())
      ? parsed.translation.trim()
      : content;
    if (!out) return json({ error: "Empty translation" }, 502);
    return json({ translation: out, tokens: null }, 200);
  }

  // Expand the compact pairs into { zh, gloss } tokens and rebuild the full
  // translation by joining the words. Accepts a bare [zh, gloss] tuple and the
  // legacy `en` key too, and degrades to the raw reply if nothing parses.
  let translation = "";
  let tokens = null;
  // The model is asked for {"t": [...]} but sometimes ignores the wrapper and
  // returns the bare array directly — accept that shape too.
  const pairs = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.t) ? parsed.t
    : Array.isArray(parsed?.tokens) ? parsed.tokens
    : null;
  if (pairs) {
    tokens = pairs
      .map((p) => (Array.isArray(p) ? { zh: p[0], gloss: p[1] } : p))
      .filter((t) => t && typeof t.zh === "string" && t.zh.length)
      .map((t) => {
        const g = typeof t.gloss === "string" ? t.gloss : (typeof t.en === "string" ? t.en : "");
        return { zh: t.zh, gloss: g.trim() };
      });
    translation = tokens.map((t) => t.zh).join("");
  }
  if (!translation) {
    // Couldn't parse tokens — use any translation field, else the raw reply.
    translation = typeof parsed?.translation === "string" && parsed.translation.trim()
      ? parsed.translation.trim()
      : content;
    tokens = null;
    console.error("Unparseable model JSON", {
      finish_reason: choice?.finish_reason,
      contentPreview: content.slice(0, 300),
    });
  }
  if (!translation) return json({ error: "Empty translation" }, 502);

  return json({ translation, tokens }, 200);
});
