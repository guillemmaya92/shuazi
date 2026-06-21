// Supabase Edge Function: tts
//
// Proxies text-to-speech requests to Google Cloud Text-to-Speech, keeping the
// Google API key as a server-side secret (never shipped to the browser).
// Returns a base64 MP3 the browser can play directly.
//
// Deploy via the Supabase dashboard (paste this file's contents), or with the
// CLI after placing it at supabase/functions/tts/index.ts.
// Secret:  GOOGLE_TTS_API_KEY=AIza...
//   (a Google Cloud API key with the "Cloud Text-to-Speech API" enabled)
//
// The browser calls this with the public Supabase anon key as the bearer token
// (same as any other Edge Function). The real Google key lives only here.

const MAX_CHARS = 500;
const DEFAULT_VOICE = "cmn-CN-Wavenet-A"; // high-quality Mainland Mandarin (female)
const LANG = "cmn-CN";

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

  let text, voice, rate;
  try {
    ({ text, voice, rate } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof text !== "string" || !text.trim()) {
    return json({ error: 'Missing "text"' }, 400);
  }
  if (text.length > MAX_CHARS) {
    return json({ error: `Text too long (max ${MAX_CHARS} chars)` }, 413);
  }

  const key = Deno.env.get("GOOGLE_TTS_API_KEY")?.trim();
  if (!key) return json({ error: "Server not configured" }, 500);

  const speakingRate = Math.min(2, Math.max(0.5, Number(rate) || 0.9));
  const voiceName = typeof voice === "string" && voice.trim() ? voice.trim() : DEFAULT_VOICE;

  let resp;
  try {
    resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: LANG, name: voiceName },
          audioConfig: { audioEncoding: "MP3", speakingRate },
        }),
      },
    );
  } catch (e) {
    return json({ error: "Upstream request failed", detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return json({ error: `Google TTS ${resp.status}`, detail }, 502);
  }

  const data = await resp.json();
  const audio = data?.audioContent;
  if (!audio) return json({ error: "Empty audio response" }, 502);

  // base64-encoded MP3; the browser turns it into a playable data/blob URL.
  return json({ audio, mime: "audio/mpeg" }, 200);
});
