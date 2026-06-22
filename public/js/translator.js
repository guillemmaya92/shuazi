/* ── TRANSLATOR ──
   Translates any language to Chinese — DeepSeek via a Supabase Edge Function
   (which proxies OpenRouter, keeping the key server-side) — then segments the
   result into words with pinyin (pinyin-pro). The heavy library is loaded
   lazily the first time the tab is opened so it never sits on the critical
   path. */

import { SUPA_URL, SUPA_KEY } from './config.js';

const PUNCT_RE   = /^[\s\p{P}]+$/u;
const CJK_RE     = /[㐀-鿿豈-﫿]/;     // han characters
const WORD_RE    = /[\p{L}\p{N}]/u;                     // any letter or number

let segment, addDict, OutputFormat, pinyin;
let libsPromise = null; // de-dupes concurrent loads

// Lazy-load pinyin-pro (+ full dictionary). A failure loading the full
// dictionary degrades gracefully to the built-in basic one.
function ensureLibs() {
  if (libsPromise) return libsPromise;
  libsPromise = (async () => {
    const pp = await import('https://esm.sh/pinyin-pro');
    ({ segment, addDict, OutputFormat, pinyin } = pp);

    try {
      const res  = await fetch('https://cdn.jsdelivr.net/npm/@pinyin-pro/data/complete.json');
      addDict(await res.json());
    } catch (e) {
      console.warn('Translator: full dictionary failed, using built-in basic one:', e);
    }
  })();
  return libsPromise;
}

// DeepSeek via the Supabase Edge Function (proxies OpenRouter server-side).
// DeepSeek detects the source language itself and returns the translation
// already segmented into word tokens, each with a literal English gloss.
// Resolves to { translation, tokens } — tokens may be null (raw-text fallback).
async function translateToChinese(text) {
  if (CJK_RE.test(text)) return { translation: text, tokens: null }; // already Chinese

  // Cache identical inputs in localStorage — repeated phrases return instantly.
  const cacheKey = 'tr:' + text;
  try {
    const hit = localStorage.getItem(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch { /* ignore parse/quota errors */ }

  const response = await fetch(`${SUPA_URL}/functions/v1/translator`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ? `${data.error}${data.detail ? ': ' + data.detail : ''}` : 'Translate function ' + response.status);
  }
  let out = data?.translation?.trim();
  if (!out) throw new Error('Empty translation response');
  let tokens = Array.isArray(data.tokens) ? data.tokens : null;

  // Safety net: if the server ever leaks a raw JSON blob as the translation
  // (e.g. an older function build, or the model wrapping it in a code fence),
  // recover the real translation and tokens here so the UI never shows JSON.
  if (!tokens && /^\s*```|^\s*\{[\s\S]*"translation"/.test(out)) {
    const stripped = out.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const start = stripped.indexOf('{'), end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(stripped.slice(start, end + 1));
        if (typeof parsed.translation === 'string' && parsed.translation.trim()) out = parsed.translation.trim();
        if (Array.isArray(parsed.tokens)) tokens = parsed.tokens;
      } catch { /* leave out as-is */ }
    }
  }
  const result = { translation: out, tokens };
  try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch { /* quota full — skip */ }
  return result;
}

// Picks the best available Mandarin voice. Voices load asynchronously, so this
// is re-evaluated lazily (and on `voiceschanged`). Preference order favours the
// higher-quality network voices (Google / Microsoft natural) over the basic
// local ones, and Mainland Mandarin (zh-CN) over other Chinese variants.
let zhVoice = null;
function pickChineseVoice() {
  const voices = speechSynthesis.getVoices();
  const zh = voices.filter(v => /^zh\b|^cmn\b|zh[-_]/i.test(v.lang) || /chinese|mandarin|普通话|中文/i.test(v.name));
  if (!zh.length) return null;
  const score = v => {
    let s = 0;
    if (/zh[-_]?cn|cmn[-_]?hans|普通话/i.test(v.lang + ' ' + v.name)) s += 4; // Mainland Mandarin
    if (/google/i.test(v.name)) s += 3;                                       // Google network voices
    if (/natural|xiaoxiao|yunyang|xiaoyi|微软|huihui/i.test(v.name)) s += 2;   // MS natural voices
    if (!v.localService) s += 1;                                              // network > local
    return s;
  };
  return zh.sort((a, b) => score(b) - score(a))[0];
}
function getChineseVoice() {
  if (!zhVoice) zhVoice = pickChineseVoice();
  return zhVoice;
}
if ('speechSynthesis' in window) {
  // Voices are often not ready on first call; refresh once they arrive.
  speechSynthesis.addEventListener?.('voiceschanged', () => { zhVoice = pickChineseVoice(); });
}

// Speaks Chinese text via the Web Speech API (fallback). `onState` (optional)
// is called with true when playback starts and false when it ends.
function speakWebSpeech(text, onState) {
  if (!('speechSynthesis' in window) || !text) { onState?.(false); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  const voice = getChineseVoice();
  if (voice) u.voice = voice;
  u.rate = 0.9;
  if (onState) {
    u.onstart = () => onState(true);
    u.onend   = () => onState(false);
    u.onerror = () => onState(false);
  }
  speechSynthesis.speak(u);
}

// ── Cloud TTS (Google via the Supabase Edge Function) ──
// High-quality, consistent Mandarin across all devices. Audio is cached in
// memory (instant replay) and in localStorage (survives reloads, saves quota).
const ttsMem = new Map();        // text -> object URL for this session
let stopCurrent = null;          // stops whatever is currently playing

function b64ToUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
}

// Resolves to a playable object URL, hitting localStorage then the network.
async function fetchTtsUrl(text) {
  if (ttsMem.has(text)) return ttsMem.get(text);
  const lsKey = 'tts:' + text;
  let b64 = null;
  try { b64 = localStorage.getItem(lsKey); } catch { /* ignore */ }
  if (!b64) {
    const res = await fetch(`${SUPA_URL}/functions/v1/tts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.audio) throw new Error(data.error || 'TTS ' + res.status);
    b64 = data.audio;
    try { localStorage.setItem(lsKey, b64); } catch { /* quota full — skip persisting */ }
  }
  const url = b64ToUrl(b64, 'audio/mpeg');
  ttsMem.set(text, url);
  return url;
}

function stopPlayback() {
  if (stopCurrent) { stopCurrent(); stopCurrent = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// Speaks Chinese text. Tries cloud TTS first, falls back to Web Speech on any
// failure. `onState` (optional) toggles UI feedback (true while playing).
async function speak(text, onState) {
  if (!text) return;
  stopPlayback();
  onState?.(true);
  let cleared = false;
  const done = () => { if (!cleared) { cleared = true; onState?.(false); } };
  try {
    const url = await fetchTtsUrl(text);
    const audio = new Audio(url);
    stopCurrent = () => { audio.pause(); done(); };
    audio.onended = () => { done(); stopCurrent = null; };
    audio.onerror = () => { done(); stopCurrent = null; };
    await audio.play();
  } catch (e) {
    console.warn('Cloud TTS failed, using Web Speech fallback:', e);
    done();
    speakWebSpeech(text, onState);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Normalises the server tokens ({ zh, en }) into the render shape, computing
// pinyin per word locally. `en` is the literal English gloss shown as a legend.
function tokensFromServer(tokens) {
  return tokens
    .filter(t => t && typeof t.zh === 'string' && t.zh.length)
    .map(t => {
      const origin = t.zh;
      const latin = !CJK_RE.test(origin) && WORD_RE.test(origin);
      const punct = !latin && PUNCT_RE.test(origin);
      return {
        origin,
        result: latin || punct ? '' : pinyin(origin),
        en: typeof t.en === 'string' ? t.en : '',
        latin,
        punct,
      };
    });
}

// Fallback when the model didn't return tokens: segment locally with pinyin-pro
// (no English glosses available in this path).
function tokensFromSegment(zhText) {
  const segments = segment(zhText, { format: OutputFormat.AllSegment });

  // pinyin-pro splits non-Han words (e.g. names like "Guillem") character by
  // character — merge consecutive latin/number segments back into one token.
  const merged = [];
  let buf = null;
  for (const seg of segments) {
    const isLatinWord = !CJK_RE.test(seg.origin) && WORD_RE.test(seg.origin);
    if (isLatinWord) {
      if (buf) buf.origin += seg.origin;
      else buf = { origin: seg.origin, result: '', en: '', latin: true };
      continue;
    }
    if (buf) { merged.push(buf); buf = null; }
    const punct = PUNCT_RE.test(seg.origin);
    merged.push({ origin: seg.origin, result: seg.result, en: '', latin: false, punct });
  }
  if (buf) merged.push(buf);
  return merged;
}

function renderTokens(zhText, tokens, resultEl) {
  resultEl.innerHTML = '';
  const list = (tokens && tokens.length) ? tokensFromServer(tokens) : tokensFromSegment(zhText);

  for (const seg of list) {
    const isPunct = !seg.latin && (seg.punct ?? PUNCT_RE.test(seg.origin));
    const hasGloss = !isPunct && !!seg.en;
    const el = document.createElement('div');
    el.className = 'tr-token' + (isPunct ? ' punct' : '');
    const py  = seg.latin || isPunct ? '' : seg.result;
    const en  = hasGloss ? `<span class="en">${escapeHtml(seg.en)}</span>` : '';
    el.innerHTML = `<span class="py">${py}</span><span class="zh">${escapeHtml(seg.origin)}</span>${en}`;
    // Tap a (non-punctuation) token to hear that word. The English gloss is
    // shown only via the eye toggle in the section header.
    if (!isPunct) {
      el.addEventListener('click', () => {
        // Mark this word as selected (keeps the gradient border), exclusive.
        resultEl.querySelectorAll('.tr-token.selected').forEach(t => t.classList.remove('selected'));
        el.classList.add('selected');
        speak(seg.origin, on => el.classList.toggle('speaking', on));
      });
    }
    resultEl.appendChild(el);
  }
}

let wired = false;

// Wires the DOM once and kicks off the lazy library load. Safe to call on
// every tab open — only the first call does work.
export function initTranslator() {
  const input      = document.getElementById('trInput');
  const button     = document.getElementById('trGo');
  const resultEl   = document.getElementById('trResult');
  const emptyEl     = document.getElementById('trEmpty');
  const zhLineEl    = document.getElementById('trZh');
  const speakBtn    = document.getElementById('trSpeak');
  const clearBtn    = document.getElementById('trClear');
  const countEl      = document.getElementById('trCount');
  const zhSection    = document.getElementById('trZhSection');
  const tokensSection = document.getElementById('trTokensSection');
  const eyeBtn       = document.getElementById('trEye');
  if (!input || !button) return;

  // Start loading the library as soon as the tab is first opened.
  ensureLibs().then(() => {
    button.disabled = false;
  });

  // The listen button only makes sense with speech synthesis available.
  const canSpeak = !!speakBtn && 'speechSynthesis' in window;

  if (wired) return;
  wired = true;

  // Listen to the full Chinese sentence.
  if (canSpeak) {
    speakBtn.addEventListener('click', () => {
      speak(zhLineEl.textContent, on => speakBtn.classList.toggle('playing', on));
    });
  }

  // The eye reveals / hides every English gloss at once.
  if (eyeBtn) {
    eyeBtn.addEventListener('click', () => {
      const showing = eyeBtn.classList.toggle('showing');
      resultEl.querySelectorAll('.tr-token').forEach(t => {
        if (t.querySelector('.en')) t.classList.toggle('revealed', showing);
      });
    });
  }

  // Shows the eye only when there are glosses to reveal, and resets it (and any
  // per-word reveals) to the default hidden state for each new translation.
  function syncEye() {
    if (!eyeBtn) return;
    const hasGlosses = !!resultEl.querySelector('.en');
    eyeBtn.style.display = hasGlosses ? '' : 'none';
    eyeBtn.classList.remove('showing');
  }

  function hideSections() {
    zhSection.style.display = 'none';
    tokensSection.style.display = 'none';
    if (speakBtn) {
      speakBtn.style.display = 'none';
      speakBtn.classList.remove('playing');
    }
    if (eyeBtn) { eyeBtn.style.display = 'none'; eyeBtn.classList.remove('showing'); }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  async function handleSubmit() {
    const text = input.value.trim();
    resultEl.innerHTML = '';
    zhLineEl.textContent = '';
    hideSections();
    if (!text) {
      emptyEl.textContent = '';
      emptyEl.className = 'tr-empty';
      emptyEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    button.disabled = true;
    button.classList.add('tr-loading');
    try {
      await ensureLibs();
      const { translation: zh, tokens } = await translateToChinese(text);
      zhLineEl.textContent = zh;
      renderTokens(zh, tokens, resultEl);
      syncEye();
      zhSection.style.display = '';
      tokensSection.style.display = '';
      if (canSpeak) speakBtn.style.display = '';
      syncClear();
    } catch (e) {
      console.error(e);
      emptyEl.textContent = 'Could not translate: ' + e.message;
      emptyEl.className = 'tr-empty err';
      emptyEl.style.display = 'block';
    } finally {
      button.classList.remove('tr-loading');
      button.disabled = false;
    }
  }

  button.addEventListener('click', handleSubmit);
  // Enter sends (chat-style); Shift+Enter inserts a newline.
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  });

  const inputField = input.parentElement;
  // Auto-grow the textarea to fit its content (capped by max-height in CSS).
  // When the content is capped a scrollbar shows on the right edge; expose its
  // width so the clear cross and counter shift left and never sit under it.
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    // offsetWidth - clientWidth = both 1px borders + the scrollbar (0 if none).
    const sb = Math.max(0, input.offsetWidth - input.clientWidth - 2);
    inputField.style.setProperty('--sb', sb + 'px');
  };
  // Show the clear button only when there's a translation shown below.
  const syncClear = () => {
    if (!clearBtn) return;
    const hasResult = zhSection.style.display !== 'none';
    clearBtn.style.display = hasResult ? '' : 'none';
  };
  // Keep the (optional) character counter in sync with the input.
  const syncCount = () => {
    if (countEl) countEl.textContent = input.value.length;
  };
  input.addEventListener('input', () => { autoGrow(); syncClear(); syncCount(); });
  syncCount();

  // Clear only the translation, leaving the written text untouched.
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      resultEl.innerHTML = '';
      zhLineEl.textContent = '';
      hideSections();
      emptyEl.textContent = '';
      emptyEl.style.display = 'none';
      syncClear();
      input.focus();
    });
  }

  wireMic(input, () => { autoGrow(); syncClear(); syncCount(); });
}

// Appends dictated text to whatever is already in the input, then syncs the UI.
function appendDictation(input, text, onInput) {
  text = (text || '').trim();
  if (!text) return;
  const base = input.value.trim();
  input.value = base ? base + ' ' + text : text;
  onInput?.();
}

// Wires the mic button. Primary path records audio with MediaRecorder and
// transcribes it via the Groq/Whisper Edge Function (works in every browser,
// auto-detects the language). Falls back to the browser's Web Speech API when
// recording isn't available. `onInput` re-syncs the UI after text is added.
function wireMic(input, onInput) {
  const micBtn = document.getElementById('trMic');
  if (!micBtn) return;

  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  if (!canRecord) { wireMicWebSpeech(input, onInput, micBtn); return; }

  let recorder = null;
  let stream = null;
  let chunks = [];
  let recording = false;

  const setState = (s) => {
    micBtn.classList.toggle('listening', s === 'recording');
    micBtn.classList.toggle('transcribing', s === 'transcribing');
    micBtn.disabled = s === 'transcribing';
  };

  async function transcribe(blob) {
    setState('transcribing');
    try {
      const fd = new FormData();
      fd.append('file', blob, 'audio.webm');
      const res = await fetch(`${SUPA_URL}/functions/v1/stt`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPA_KEY}` }, // browser sets the multipart boundary
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'STT ' + res.status);
      appendDictation(input, data.text, onInput);
    } catch (e) {
      console.error('Transcription failed:', e);
    } finally {
      setState('idle');
    }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn('Microphone unavailable / permission denied:', e);
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recording = false;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size) transcribe(blob); else setState('idle');
    };
    recorder.start();
    recording = true;
    setState('recording');
  }

  micBtn.addEventListener('click', () => {
    if (recording) recorder.stop();
    else start();
  });
}

// Fallback: the browser's built-in Web Speech API. Dictated text is appended to
// the input. Used only when audio recording isn't available.
function wireMicWebSpeech(input, onInput, micBtn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { micBtn.style.display = 'none'; return; }

  let recognition = null;
  let listening = false;
  let base = '';

  micBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }

    recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    base = input.value.trim() ? input.value.trim() + ' ' : '';

    recognition.onstart = () => { listening = true; micBtn.classList.add('listening'); };
    recognition.onresult = e => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      input.value = base + txt;
      onInput?.();
    };
    const stop = () => { listening = false; micBtn.classList.remove('listening'); };
    recognition.onend = stop;
    recognition.onerror = stop;

    recognition.start();
  });
}
