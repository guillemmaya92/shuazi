// Supabase Edge Function: text-import
//
// Turns a photo of Chinese text into a ready-to-insert row for the `texts` table.
//   1. OCR: a vision model transcribes the photo verbatim (DeepSeek has no vision).
//   2. DeepSeek segments each paragraph into word tokens (punctuation kept as its
//      own token), glosses every word in EN + ES, and translates the paragraph.
// The function does NOT write to the database: the client inserts the result
// (RLS policy in scripts/supabase_texts_insert.sql).
//
// Deploy via the Supabase dashboard (paste this file's contents), or with the CLI
// after placing it at supabase/functions/text-import/index.ts.
// Secrets:
//   OPENROUTER_API_KEY = sk-or-v1-...
//   VISION_MODEL       = optional, defaults to deepseek/deepseek-v4.1-flash
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by the Supabase runtime.
//
// Request  (Authorization: Bearer <user access_token>):
//   { images: ["data:image/jpeg;base64,...", ...], title: "标题" }
//   `images` are consecutive pages of ONE text, in the order they were attached (1 to 5).
// Response:
//   { text, text_en, text_es, title_en, title_es, paragraphs: [{ tokens, en, es }] }

const DEEPSEEK_MODEL = "deepseek/deepseek-v4-flash";
// DeepSeek V4.1 Flash reads images natively (the older deepseek-v4-flash is text-only).
const VISION_MODEL = Deno.env.get("VISION_MODEL")?.trim() || "deepseek/deepseek-v4.1-flash";
const MAX_IMAGES = 5;                // pages per text; keep in sync with the client
const MAX_IMAGE_CHARS = 8_000_000;   // ~6 MB per image once base64-encoded
const MAX_TOTAL_IMAGE_CHARS = 24_000_000;
const SEGMENT_CONCURRENCY = 4;       // parallel DeepSeek calls
const MAX_TEXT_CHARS = 6000;
const MAX_TOKENS = 12000;
const MAX_RETRIES = 2;               // transient upstream errors (429/5xx)
const MAX_CONTENT_RETRIES = 1;       // extra DeepSeek calls when validation fails

const HAN_RE = /[㐀-鿿豈-﫿]/;

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

// Resolves the signed-in user from the bearer token, or null.
async function getUser(req) {
  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!auth.startsWith("Bearer ") || !url || !anon) return null;
  const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u?.id ? u : null;
}

// Reads profiles.is_admin with the caller's own token (RLS "own profile read"
// lets a user read their row), so no service-role key is needed here.
async function isAdmin(req, userId) {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const r = await fetch(`${url}/rest/v1/profiles?select=is_admin&id=eq.${encodeURIComponent(userId)}`, {
    headers: { Authorization: req.headers.get("Authorization") || "", apikey: anon },
  });
  if (!r.ok) return false;
  const rows = await r.json().catch(() => []);
  return rows?.[0]?.is_admin === true;
}

function parseModelJson(content) {
  const s = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* give up */ } }
  return null;
}

// POST to OpenRouter with retries on 429/5xx/network errors.
async function openRouter(key, body) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok || (resp.status !== 429 && resp.status < 500)) return resp;
      lastErr = new Error(`OpenRouter ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw lastErr;
}

// ── Step 1: OCR ──────────────────────────────────────────────────────────────
const OCR_SCHEMA = {
  name: "ocr_text",
  strict: true,
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

const OCR_PROMPT =
  "You are an OCR engine that extracts the MAIN BODY TEXT of a Chinese reading passage from a photo of a book or worksheet. " +
  "Transcribe only the main passage: the continuous running text that makes up the story, article, letter or dialogue. " +
  "Do NOT include anything else that appears on the page, namely: the passage title or chapter/lesson heading and its number, " +
  "section headings, text in the side or outer margins, sidebars, footnotes and annotations, vocabulary or word lists, " +
  "exercises, questions and instructions, captions and text inside pictures, page numbers, headers and footers, watermarks, " +
  "pinyin, translations into other languages, and decorative or navigational symbols and icons (bullets, arrows, boxes, stars, numbering markers). " +
  "Also ignore footnote and note reference markers: small superscript or bracketed numbers placed after words or sentences, such as [1], [2], [3], ①, ② or ¹, ² — never copy them. " +
  "If a speaker name in a dialogue is printed with spaces between its characters for alignment (for example 飞 龙：), write it without those spaces (飞龙：). " +
  "In a dialogue, keep the speaker labels (for example 大卫：) because they are part of the passage. " +
  "Copy the body text exactly as written: same characters (do not convert between simplified and traditional) and the same punctuation marks " +
  "(keep full-width 。，、！？：；“”‘’（） exactly as they appear), in the same order. Do not translate, correct, summarise or add anything. " +
  "Separate paragraphs (or dialogue lines) with a single line break (\\n). Join lines that merely wrap inside a paragraph. " +
  "The user may send several images: they are consecutive pages of ONE passage, in reading order. Return a single continuous transcription of the body text; " +
  "if a paragraph or sentence continues from the end of one page to the start of the next, join it into one paragraph.";

// Safety net for what the model lets through despite the prompt:
//  - footnote reference markers: [1] ［2］ 【3】 (digits only inside), circled digits
//    ①–⑳ and superscript digits ¹²³⁰-⁹;
//  - spaces BETWEEN two Han characters (letter-spaced speaker names such as "飞 龙"),
//    which never occur in normal Chinese text.
function cleanOcr(s) {
  return s
    .replace(/[\[［【]\s*\d{1,3}\s*[\]］】]/g, "")
    .replace(/[\u2460-\u2473\u00B9\u00B2\u00B3\u2070\u2074-\u2079]/g, "")
    .replace(/(?<=\p{Script=Han})[ \t\u3000]+(?=\p{Script=Han})/gu, "")
    .split(/\r?\n/)
    // Speaker label at the start of a line: normalise an ASCII/full-width-less colon to "：".
    .map((l) => l.replace(/[ \t\u3000]+$/g, "").trim().replace(/^([\p{Script=Han}A-Za-z0-9]{1,8})\s*:/u, "$1："))
    .join("\n")
    .trim();
}

async function ocr(key, images) {
  const resp = await openRouter(key, {
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_schema", json_schema: OCR_SCHEMA },
    messages: [
      { role: "system", content: OCR_PROMPT },
      { role: "user", content: images.map((url) => ({ type: "image_url", image_url: { url } })) },
    ],
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return { error: json({ error: `OCR failed (${resp.status})`, detail }, 502) };
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || "";
  const parsed = parseModelJson(content);
  const text = cleanOcr(typeof parsed?.text === "string" ? parsed.text : content);
  if (!text || !HAN_RE.test(text)) {
    return { error: json({ error: "No Chinese text found in the image" }, 422) };
  }
  return { text };
}

// ── Step 2: DeepSeek tokenize + translate ────────────────────────────────────
const PARA_SCHEMA = {
  name: "text_import",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title_en: { type: "string" },
      title_es: { type: "string" },
      paragraphs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tokens: {
              type: "array",
              items: {
                type: "object",
                properties: { zh: { type: "string" } },
                required: ["zh"],
                additionalProperties: false,
              },
            },
            en: { type: "string" },
            es: { type: "string" },
          },
          required: ["tokens", "en", "es"],
          additionalProperties: false,
        },
      },
    },
    required: ["title_en", "title_es", "paragraphs"],
    additionalProperties: false,
  },
};

const SEGMENT_PROMPT =
  "You prepare Chinese reading passages for language learners. The user gives a Chinese title and a Chinese text, one paragraph per line. " +
  "Return, for EACH input line, in the same order and count (never merge or split paragraphs): " +
  "The text is often a DIALOGUE: lines like 飞龙：你好！ start with a speaker name followed by a colon. Speaker names and other personal names (飞龙, 李钟文, 大卫, 刘老师) " +
  "are proper nouns: keep each complete name as ONE token and never split it, even if you do not know the name; the colon is its own token. " +
  "(1) \"tokens\": the paragraph segmented into natural word-level tokens. Concatenating all token \"zh\" values MUST reproduce the paragraph EXACTLY, character by character, " +
  "including every punctuation mark, digit and Latin letter (each punctuation mark is its own token). Do not add, drop, fix or normalise anything. " +
  "(2) \"en\" and \"es\": a natural full translation of the paragraph into English and Spanish, keeping the same sentences and the same punctuation style (quotes, colons, question and exclamation marks). " +
  "Also give \"title_en\" and \"title_es\": the translated title. No pinyin, no explanations.";

// Groups consecutive paragraphs into batches of at most `max` characters (a single
// longer paragraph is its own batch; paragraphs are never split).
function batchLines(lines, max = 450) {
  const groups = [];
  let cur = [], size = 0;
  for (const l of lines) {
    if (cur.length && size + l.length > max) { groups.push(cur); cur = []; size = 0; }
    cur.push(l);
    size += l.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// Like Promise.all(items.map(fn)) but with at most `limit` running at once; keeps order.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// Chars that may differ without counting as a real change (whitespace only).
const squash = (s) => s.replace(/\s+/g, "");

// Dialogue lines start with a speaker label ("大卫：", "刘老师：", "李钟文："). The label
// is a name, so it must be ONE token (like "大卫|：" in the existing texts) — a model
// will often split a name it doesn't know, e.g. 李|钟文. Merges the tokens that make
// up the label; the colon stays its own token. Never changes the concatenated text.
function mergeSpeakerLabel(tokens, line) {
  const m = line.match(/^([^：:，。！？、；“”"'（）()\[\]]{1,8})：/u);
  if (!m) return tokens;
  const want = [...m[1]].length;
  let count = 0, k = 0;
  while (k < tokens.length && count < want) { count += [...tokens[k].zh].length; k++; }
  if (count !== want || k < 2) return tokens;   // already one token, or a token straddles the label
  return [{ zh: tokens.slice(0, k).map((t) => t.zh).join("") }, ...tokens.slice(k)];
}

async function segment(key, title, text, lines) {
  const resp = await openRouter(key, {
    model: DEEPSEEK_MODEL,
    temperature: 0.1,
    max_tokens: MAX_TOKENS,
    reasoning: { enabled: false },
    response_format: { type: "json_schema", json_schema: PARA_SCHEMA },
    provider: { sort: "throughput", require_parameters: true },
    messages: [
      { role: "system", content: SEGMENT_PROMPT },
      { role: "user", content: `Title: ${title}\n\nText:\n${text}` },
    ],
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return { error: json({ error: `DeepSeek failed (${resp.status})`, detail }, 502) };
  }
  const data = await resp.json();
  const choice = data?.choices?.[0];
  const parsed = parseModelJson(choice?.message?.content?.trim() || "");
  const paras = parsed?.paragraphs;
  if (!Array.isArray(paras) || paras.length !== lines.length) return { invalid: "paragraph count mismatch" };

  const out = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    let tokens = (Array.isArray(p?.tokens) ? p.tokens : [])
      .filter((t) => t && typeof t.zh === "string" && squash(t.zh))
      .map((t) => ({ zh: squash(t.zh) }));
    tokens = mergeSpeakerLabel(tokens, squash(lines[i]));
    // The whole point: tokens must rebuild the source paragraph, punctuation included.
    if (tokens.map((t) => t.zh).join("") !== squash(lines[i])) {
      return { invalid: `tokens do not match paragraph ${i + 1}` };
    }
    out.push({
      tokens,
      en: typeof p.en === "string" ? p.en.trim() : "",
      es: typeof p.es === "string" ? p.es.trim() : "",
    });
  }
  return {
    title_en: typeof parsed.title_en === "string" ? parsed.title_en.trim() : "",
    title_es: typeof parsed.title_es === "string" ? parsed.title_es.trim() : "",
    paragraphs: out,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Only allow-listed users: this endpoint spends vision + LLM credits.
  const user = await getUser(req);
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!(await isAdmin(req, user.id))) return json({ error: "Not allowed" }, 403);

  let images, title;
  try {
    const body = await req.json();
    // `images`: pages of ONE text, in reading order. A single `image` still works.
    images = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
    title = body.title;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!images.length || images.length > MAX_IMAGES) {
    return json({ error: `Send between 1 and ${MAX_IMAGES} images` }, 400);
  }
  if (!images.every((im) => typeof im === "string" && /^data:image\/(png|jpe?g|webp);base64,/i.test(im))) {
    return json({ error: 'Invalid "images" (data URLs: png, jpeg or webp)' }, 400);
  }
  if (images.some((im) => im.length > MAX_IMAGE_CHARS) || images.reduce((n, im) => n + im.length, 0) > MAX_TOTAL_IMAGE_CHARS) {
    return json({ error: "Images too large" }, 413);
  }
  title = typeof title === "string" ? title.trim().slice(0, 200) : "";

  const key = Deno.env.get("OPENROUTER_API_KEY")?.trim();
  if (!key) return json({ error: "Server not configured" }, 500);

  try {
    const o = await ocr(key, images);
    if (o.error) return o.error;
    if (o.text.length > MAX_TEXT_CHARS) return json({ error: `Text too long (max ${MAX_TEXT_CHARS} chars)` }, 413);

    const lines = o.text.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);

    // Long texts are tokenized in batches of paragraphs: one reply holding every
    // token of a multi-page text would overflow max_tokens and come back truncated.
    const groups = batchLines(lines);
    const parts = await mapPool(groups, SEGMENT_CONCURRENCY, async (group) => {
      let seg;
      for (let attempt = 0; attempt <= MAX_CONTENT_RETRIES; attempt++) {
        seg = await segment(key, title, group.join("\n"), group);
        if (seg.error || !seg.invalid) return seg;
        console.error("segment attempt invalid:", seg.invalid);
      }
      return seg;
    });
    const failed = parts.find((p) => p.error);
    if (failed) return failed.error;
    const bad = parts.find((p) => p.invalid);
    if (bad) return json({ error: "Could not tokenize the text faithfully", detail: bad.invalid }, 502);

    const seg = {
      title_en: parts[0].title_en,
      title_es: parts[0].title_es,
      paragraphs: parts.flatMap((p) => p.paragraphs),
    };

    return json({
      text: seg.paragraphs.map((p) => p.tokens.map((t) => t.zh).join("|")).join("\n\n"),
      text_en: seg.paragraphs.map((p) => p.en).join("\n\n"),
      text_es: seg.paragraphs.map((p) => p.es).join("\n\n"),
      title_en: seg.title_en,
      title_es: seg.title_es,
      paragraphs: seg.paragraphs,
    });
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }
});
