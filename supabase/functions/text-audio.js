// Supabase Edge Function: text-audio
//
// Pre-generates the audio of ONE text (the reader's ▶ button), the same thing
// scripts/build_text_audio.py does for every text, but callable from the app:
//   1. Splits the text into sentences and picks a voice per speaker, with the SAME
//      rules as public/js/texts.js (startListen) and the Python script.
//   2. For every sentence, makes sure the clip tts/v1/<sha256(voice|rate|text)>.mp3
//      exists in Storage, synthesizing it through the `tts` Edge Function if not.
//   3. Once every clip exists, uploads the manifest tts/texts/<id>.json and stores
//      its public URL in texts.audio_url.
//
// Speakers: the fixed cast (大卫, 玛丽, 刘老师…) keeps its fixed voice. In a dialogue,
// any OTHER name that heads several lines ("飞龙：", "李钟文：") is a new speaker and gets
// a voice that is free in that text. The choice is saved in the manifest ("speakers")
// and the reader uses it, so the same names keep their voices.
//
// It runs IN THE BACKGROUND: the function validates the text, answers 202 straight away
// and keeps working (EdgeRuntime.waitUntil), so the app does not have to stay open.
// The job creates the missing clips in rounds, then publishes the manifest; texts.audio_url
// stays empty until then. Clips that already exist are skipped, so calling it again is
// safe (that is the retry). Errors only go to the function logs.
//
// Deploy via the Supabase dashboard (paste this file's contents), or with the CLI
// after placing it at supabase/functions/text-audio/index.ts.
// Needs the `tts` function (GOOGLE_TTS_API_KEY) and the `tts` Storage bucket
// (scripts/supabase_tts_cache.sql). SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are provided by the Supabase runtime.
//
// Request  (Authorization: Bearer <admin's access_token>):  { id: <texts.id> }
// Response: 202 { started: true, sentences }   (the work continues after the response)

// ── Must match public/js/texts.js and scripts/build_text_audio.py ────────────
const LISTEN_RATE = 0.75;
const DEFAULT_VOICE = "cmn-CN-Wavenet-A";
const V = {
  WA: "cmn-CN-Wavenet-A", WB: "cmn-CN-Wavenet-B", WC: "cmn-CN-Wavenet-C", WD: "cmn-CN-Wavenet-D",
  SA: "cmn-CN-Standard-A", SB: "cmn-CN-Standard-B", SC: "cmn-CN-Standard-C", SD: "cmn-CN-Standard-D",
};
const SPEAKER_VOICES = {
  "玛丽": V.WA, "张红": V.WD, "大卫": V.WB, "李军": V.WC,
  "中村": V.SB,
  "刘老师": V.SA, "老师": V.SA, "王老师": V.SD,
  "安娜": V.SD, "妈妈": V.SA, "售货员": V.SD,
  "警察": V.SC, "画家": V.SC, "工作人员": V.SC, "工人": V.SB,
  "学生": V.SC, "学生A": V.SD, "学生B": V.SC, "同学": V.SC,
};
// Voices handed to NEW speakers, in this order (male / female alternating, the
// best-quality Wavenet voices first). Voices already used by the text's known
// speakers are skipped so two characters of a dialogue never share a voice.
const POOL = [V.WB, V.WA, V.WC, V.WD, V.SB, V.SA, V.SC, V.SD];

const BATCH_MAX = 24;      // clips per round (the existing ones are re-checked between rounds)
const CONCURRENCY = 4;     // parallel TTS calls
const JOB_BUDGET_MS = 120_000;   // stop starting new rounds after this; background limit is 150 s (free plan)
const HEAD_CONCURRENCY = 8;

const ZH_END = new Set([..."。！？!?…"]);
const CLOSERS = new Set([..."”’」』）)》]\"'"]);
const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]/u;
const CJK_RE = /[\u3400-\u9fff]/;
const PARA_SPLIT = /(?:\r?\n|\\n|\u2028|\u2029)+/;

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

// ── Admin check (same as text-import) ────────────────────────────────────────
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

// ── Sentences and speakers (mirror of startListen in texts.js) ───────────────
const paragraphsOf = (s) => String(s || "").split(PARA_SPLIT).map((p) => p.trim()).filter(Boolean);

// Char-level sentence split: boundaries only depend on punctuation.
function sentencesOf(paragraph) {
  const chars = [...paragraph.replaceAll("|", "")];
  const out = [];
  let cur = [], ended = false;
  for (const ch of chars) {
    if (ended && !CLOSERS.has(ch) && !ZH_END.has(ch)) { out.push(cur); cur = []; ended = false; }
    cur.push(ch);
    if (ZH_END.has(ch)) ended = true;
  }
  if (cur.length) out.push(cur);
  return out;
}

// For a paragraph's first sentence: { label, colon, skip } when it starts with
// "（stage direction）Label：…" and something Chinese is said after the colon.
function speakerLine(s) {
  let skip = 0;
  if (s[0] === "（" || s[0] === "(") {
    let close = -1;
    for (let i = 1; i < s.length; i++) if (s[i] === "）" || s[i] === ")") { close = i; break; }
    if (close > 0) skip = close + 1;
  }
  let colon = -1;
  for (let i = skip; i < s.length; i++) if (s[i] === "：" || s[i] === ":") { colon = i; break; }
  const label = colon > skip ? s.slice(skip, colon).join("").trim() : "";
  const says = colon >= 0 && s.slice(colon + 1).some((c) => HAN_RE.test(c));
  return { label, colon, skip, says };
}

// Names that head lines of a dialogue but are not in the fixed cast. A label counts
// only if it heads at least 2 paragraphs AND the text has at least 2 such names
// (so a letter's "刘老师：" salutation or a repeated heading is not mistaken for one).
function findNewSpeakers(paras) {
  const count = new Map();
  for (const p of paras) {
    const s = sentencesOf(p)[0];
    if (!s) continue;
    const { label, says } = speakerLine(s);
    if (!label || !says || label.length > 8 || /[，。！？、；“”"'（）()\[\]\s]/.test(label)) continue;
    count.set(label, (count.get(label) || 0) + 1);
  }
  const names = [...count].filter(([name, n]) => n >= 2 && !SPEAKER_VOICES[name]).map(([name]) => name);
  const cast = [...count.keys()].filter((name) => SPEAKER_VOICES[name]);
  return names.length + cast.length >= 2 ? names : [];
}

function assignVoices(names, paras) {
  const used = new Set();
  for (const p of paras) {
    const s = sentencesOf(p)[0];
    const { label } = s ? speakerLine(s) : {};
    if (label && SPEAKER_VOICES[label]) used.add(SPEAKER_VOICES[label]);
  }
  const speakers = {};
  let i = 0;
  for (const name of names) {
    let v = POOL.find((x) => !used.has(x));
    if (!v) v = POOL[i % POOL.length];   // more speakers than voices: reuse
    used.add(v);
    speakers[name] = v;
    i++;
  }
  return speakers;
}

function buildLines(text, speakers) {
  const voiceOf = (label) => SPEAKER_VOICES[label] || speakers[label];
  const lines = [];
  let voice = null;
  paragraphsOf(text).forEach((p, pi) => {
    sentencesOf(p).forEach((s, si) => {
      let skip = 0;
      if (si === 0) {
        const sp = speakerLine(s);
        skip = sp.skip;
        if (sp.label && voiceOf(sp.label) && sp.says) {
          voice = voiceOf(sp.label);
          skip = sp.colon + 1;
        }
      }
      const line = s.slice(skip).join("").replace(/\s+/g, "").trim();
      if (!CJK_RE.test(line)) return;
      lines.push({ p: pi, s: si, voice: voice || DEFAULT_VOICE, text: line });
    });
  });
  return lines;
}

// Must match cachePath() in public/js/translator.js and clip_path() in the script.
async function clipPath(voice, text) {
  const r = Math.min(2, Math.max(0.5, LISTEN_RATE));
  const data = new TextEncoder().encode(`${voice || DEFAULT_VOICE}|${r}|${text}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return "v1/" + [...hash].map((b) => b.toString(16).padStart(2, "0")).join("") + ".mp3";
}

async function sha256Hex12(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

// Like Promise.all(items.map(fn)) with at most `limit` running at once; keeps order.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Synthesizes one sentence and stores its clip. Tries twice (a TTS hiccup is common).
async function makeClip(ctx, ln) {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await fetch(`${ctx.base}/functions/v1/tts`, {
      method: "POST",
      headers: { ...ctx.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: ln.text, voice: ln.voice, rate: LISTEN_RATE }),
    }).catch(() => null);
    const data = t?.ok ? await t.json().catch(() => ({})) : {};
    if (!data.audio) { last = `TTS ${t?.status ?? "network error"} for "${ln.text.slice(0, 20)}"`; continue; }
    const mp3 = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
    const up = await fetch(`${ctx.base}/storage/v1/object/tts/${ln.path}`, {
      method: "POST",
      headers: { ...ctx.auth, "Content-Type": "audio/mpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000" },
      body: mp3,
    }).catch(() => null);
    if (up?.ok) return;
    last = `Storage upload ${up?.status ?? "network error"}`;
  }
  throw new Error(last);
}

// The whole job: create every missing clip (in batches), then publish the manifest
// and point the text at it. Runs in the background after the HTTP response, so it
// has its own time budget (the platform's background limit is 150 s on the free plan).
async function runJob(ctx) {
  const { base, auth, publicBase, id, lines, speakers, deadline } = ctx;
  const unique = [...new Map(lines.map((ln) => [ln.path, ln])).values()];   // a sentence can repeat

  const made = new Set();   // clips created by this job: don't trust a cached 404 for them
  for (;;) {
    const pending = unique.filter((ln) => !made.has(ln.path));
    const exists = await mapPool(pending, HEAD_CONCURRENCY, async (ln) => {
      const h = await fetch(publicBase + ln.path, { method: "HEAD" }).catch(() => null);
      return h?.status === 200;
    });
    const missing = pending.filter((_, i) => !exists[i]);
    if (!missing.length) break;
    if (Date.now() > deadline) throw new Error(`time budget exhausted, ${missing.length} clips missing (run it again)`);
    const batch = missing.slice(0, BATCH_MAX);
    await mapPool(batch, CONCURRENCY, (ln) => makeClip(ctx, ln));
    batch.forEach((ln) => made.add(ln.path));
  }

  const manifest = {
    version: 1,
    text_id: id,
    rate: LISTEN_RATE,
    speakers,
    lines: lines.map(({ p, s, voice, text, path }) => ({ p, s, voice, text, path })),
  };
  const raw = new TextEncoder().encode(JSON.stringify(manifest));
  const up = await fetch(`${base}/storage/v1/object/tts/texts/${id}.json`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "x-upsert": "true", "Cache-Control": "no-cache" },
    body: raw,
  });
  if (!up.ok) throw new Error(`manifest upload ${up.status}: ${await up.text().catch(() => "")}`);
  const audioUrl = `${publicBase}texts/${id}.json?v=${await sha256Hex12(raw)}`;
  const patch = await fetch(`${base}/rest/v1/texts?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ audio_url: audioUrl }),
  });
  if (!patch.ok) throw new Error(`could not save audio_url ${patch.status}: ${await patch.text().catch(() => "")}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!(await isAdmin(req, user.id))) return json({ error: "Not allowed" }, 403);

  let id;
  try {
    ({ id } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  id = Number(id);
  if (!Number.isInteger(id) || id < 0) return json({ error: 'Missing "id"' }, 400);

  const base = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !svc) return json({ error: "Server not configured" }, 500);
  const auth = { apikey: svc, Authorization: `Bearer ${svc}` };
  const publicBase = `${base}/storage/v1/object/public/tts/`;

  try {
    // Validate quickly, so the caller still gets a real error for a bad id / empty text.
    const r = await fetch(`${base}/rest/v1/texts?select=id,text&id=eq.${id}`, { headers: auth });
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return json({ error: "Text not found" }, 404);

    const paras = paragraphsOf(rows[0].text);
    const speakers = assignVoices(findNewSpeakers(paras), paras);
    const lines = buildLines(rows[0].text, speakers);
    if (!lines.length) return json({ error: "The text has no sentences to read" }, 422);
    for (const ln of lines) ln.path = await clipPath(ln.voice, ln.text);

    const ctx = { base, auth, publicBase, id, lines, speakers, deadline: Date.now() + JOB_BUDGET_MS };
    const job = runJob(ctx).catch((e) => console.error(`text-audio ${id} failed:`, String(e)));

    // Answer right away and keep working after the response (the client doesn't wait).
    // Outside the Supabase runtime (local dev) there is no EdgeRuntime: just wait.
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(job);
      return json({ started: true, sentences: lines.length }, 202);
    }
    await job;
    return json({ started: true, finished: true, sentences: lines.length }, 200);
  } catch (e) {
    return json({ error: "Audio generation failed", detail: String(e) }, 502);
  }
});
