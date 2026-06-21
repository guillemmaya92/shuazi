// Supabase Edge Function: stt (speech-to-text)
//
// Proxies audio transcription to Groq (Whisper large-v3), keeping the Groq API
// key as a server-side secret (never shipped to the browser). Whisper detects
// the spoken language automatically, which suits the "type in any language"
// input. The browser records audio with MediaRecorder and POSTs it here as
// multipart/form-data under the field "file".
//
// Deploy via the Supabase dashboard (paste this file's contents), or with the
// CLI after placing it at supabase/functions/stt/index.ts.
// Secret:  GROQ_API_KEY=gsk_...
//
// The browser calls this with the public Supabase anon key as the bearer token
// (same as any other Edge Function). The real Groq key lives only here.

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3";
const MAX_BYTES = 25 * 1024 * 1024; // Groq's per-request audio limit

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

  const key = Deno.env.get("GROQ_API_KEY")?.trim();
  if (!key) return json({ error: "Server not configured" }, 500);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: 'Missing "file"' }, 400);
  if (file.size > MAX_BYTES) return json({ error: "Audio too large (max 25MB)" }, 413);

  // Optional hint; omit to let Whisper auto-detect the language.
  const language = form.get("language");

  const out = new FormData();
  out.append("file", file, file.name || "audio.webm");
  out.append("model", MODEL);
  out.append("response_format", "json");
  out.append("temperature", "0");
  if (typeof language === "string" && language.trim()) out.append("language", language.trim());

  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}` },
      body: out,
    });
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return json({ error: `Groq ${resp.status}`, detail }, 502);
  }

  const data = await resp.json();
  const text = (data?.text ?? "").trim();
  return json({ text }, 200);
});
