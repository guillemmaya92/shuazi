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

let segment, addDict, OutputFormat;
let libsPromise = null; // de-dupes concurrent loads

// Lazy-load pinyin-pro (+ full dictionary). A failure loading the full
// dictionary degrades gracefully to the built-in basic one.
function ensureLibs() {
  if (libsPromise) return libsPromise;
  libsPromise = (async () => {
    const pp = await import('https://esm.sh/pinyin-pro');
    ({ segment, addDict, OutputFormat } = pp);

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
// DeepSeek detects the source language itself.
async function translateToChinese(text) {
  if (CJK_RE.test(text)) return text; // already Chinese — nothing to translate
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
  const out = data?.translation?.trim();
  if (!out) throw new Error('Empty translation response');
  return out;
}

// Speaks Chinese text via the Web Speech API. `onState` (optional) is called
// with true when playback starts and false when it ends, for UI feedback.
function speak(text, onState) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.9;
  if (onState) {
    u.onstart = () => onState(true);
    u.onend   = () => onState(false);
    u.onerror = () => onState(false);
  }
  speechSynthesis.speak(u);
}

function renderTokens(zhText, resultEl) {
  resultEl.innerHTML = '';
  const segments = segment(zhText, { format: OutputFormat.AllSegment });

  // pinyin-pro splits non-Han words (e.g. names like "Guillem") character by
  // character — merge consecutive latin/number segments back into one token.
  const merged = [];
  let buf = null;
  for (const seg of segments) {
    const isLatinWord = !CJK_RE.test(seg.origin) && WORD_RE.test(seg.origin);
    if (isLatinWord) {
      if (buf) buf.origin += seg.origin;
      else buf = { origin: seg.origin, result: '', latin: true };
      continue;
    }
    if (buf) { merged.push(buf); buf = null; }
    merged.push({ origin: seg.origin, result: seg.result, latin: false });
  }
  if (buf) merged.push(buf);

  for (const seg of merged) {
    const isPunct = !seg.latin && PUNCT_RE.test(seg.origin);
    const el = document.createElement('div');
    el.className = 'tr-token' + (isPunct ? ' punct' : '');
    el.innerHTML = `<span class="py">${seg.latin || isPunct ? '' : seg.result}</span><span class="zh">${seg.origin}</span>`;
    // Tap a (non-punctuation) token to hear that word on its own.
    if (!isPunct) {
      el.addEventListener('click', () => {
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
  const zhSection    = document.getElementById('trZhSection');
  const tokensSection = document.getElementById('trTokensSection');
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

  function hideSections() {
    zhSection.style.display = 'none';
    tokensSection.style.display = 'none';
    if (speakBtn) {
      speakBtn.style.display = 'none';
      speakBtn.classList.remove('playing');
    }
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
    try {
      await ensureLibs();
      const zh = await translateToChinese(text);
      zhLineEl.textContent = zh;
      renderTokens(zh, resultEl);
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
      button.disabled = false;
    }
  }

  button.addEventListener('click', handleSubmit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
  });

  // Auto-grow the textarea to fit its content (capped by max-height in CSS).
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  };
  // Show the clear button whenever there's something to clear: input text or
  // a translation shown below.
  const syncClear = () => {
    if (!clearBtn) return;
    const hasResult = zhSection.style.display !== 'none';
    clearBtn.style.display = (input.value.trim() || hasResult) ? '' : 'none';
  };
  input.addEventListener('input', () => { autoGrow(); syncClear(); });

  // Clear the input and any previous translation.
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      autoGrow();
      resultEl.innerHTML = '';
      zhLineEl.textContent = '';
      hideSections();
      emptyEl.textContent = '';
      emptyEl.style.display = 'none';
      syncClear();
      input.focus();
    });
  }

  wireMic(input, () => { autoGrow(); syncClear(); });
}

// Wires the mic button to the Web Speech API (speech-to-text). Dictated text
// is appended to whatever is already in the input. Hidden when unsupported.
function wireMic(input, autoGrow) {
  const micBtn = document.getElementById('trMic');
  if (!micBtn) return;
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
      if (autoGrow) autoGrow();
    };
    const stop = () => { listening = false; micBtn.classList.remove('listening'); };
    recognition.onend = stop;
    recognition.onerror = stop;

    recognition.start();
  });
}
