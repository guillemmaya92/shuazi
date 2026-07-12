/* ── TRANSLATOR ──
   Translates any language to Chinese — DeepSeek via a Supabase Edge Function
   (which proxies OpenRouter, keeping the key server-side) — then segments the
   result into words with pinyin (pinyin-pro). The heavy library is loaded
   lazily the first time the tab is opened so it never sits on the critical
   path. */

import { SUPA_URL, SUPA_KEY, supa } from './config.js';
import { state } from './state.js';
import { t, applyStaticTranslations } from './i18n.js';
import { setupPullRefresh } from './pull-refresh.js';

const PUNCT_RE   = /^[\s\p{P}]+$/u;
const CJK_RE     = /[㐀-鿿豈-﫿]/;     // han characters
const WORD_RE    = /[\p{L}\p{N}]/u;                     // any letter or number

// Output languages. Chinese ('zh') is the rich mode (tokens + pinyin + cloud TTS);
// the others return a plain translation, spoken via the browser's Web Speech in
// the matching locale. `label` is what the composer pill shows.
export const TR_LANGS = {
  zh: { label: '中文',    speech: 'zh-CN' },
  en: { label: 'English', speech: 'en-US' },
  es: { label: 'Español', speech: 'es-ES' },
};

// The chosen output language. Always defaults to Chinese on load (not persisted);
// a change only lasts for the current session.
let trTarget = 'zh';
export function getTrTarget() { return trTarget; }
export function setTrTarget(lang) {
  if (!TR_LANGS[lang]) return;
  trTarget = lang;
}

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
// DeepSeek detects the source language itself. For Chinese ('zh') it returns the
// translation already segmented into word tokens, each with a per-word gloss in the
// app's language; for other targets it returns just the translation (tokens null).
// Resolves to { translation, tokens } — tokens may be null.
// A result only counts as a real translation if it actually looks like one, so a
// model that echoes/garbles the input (e.g. returning the source words in the token
// "zh" fields, which get joined into "holaquétaltodobien") is caught, not shown.
function isValidTranslation(out, text, target) {
  if (!out || !out.trim()) return false;
  // A Chinese translation must contain Han characters — without them it's not one.
  if (target === 'zh') return CJK_RE.test(out);
  // Other targets: reject a verbatim echo of the input (ignoring spaces and case).
  const norm = s => s.replace(/\s+/g, '').toLowerCase();
  return norm(out) !== norm(text);
}

// One round-trip to the translator Edge Function, returning { translation, tokens }.
async function requestTranslation(text, target, gloss) {
  const response = await fetch(`${SUPA_URL}/functions/v1/translator`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, target, gloss }),
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
  return { translation: out, tokens };
}

async function translate(text, target) {
  // Only short-circuit when the text is already in the requested language.
  if (target === 'zh' && CJK_RE.test(text)) return { translation: text, tokens: null };

  // Per-word glosses (Chinese mode) are written in the app's UI language.
  const gloss = state.lang === 'es' ? 'es' : 'en';

  // Cache identical inputs in localStorage — repeats return instantly. The key
  // includes the gloss language for Chinese, whose tokens depend on it.
  const cacheKey = target === 'zh' ? `tr:${target}:${gloss}:${text}` : `tr:${target}:${text}`;
  try {
    const hit = localStorage.getItem(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch { /* ignore parse/quota errors */ }

  // Validate the result; the model is non-deterministic, so a bad reply (an echo of
  // the input rather than a translation) is retried once before surfacing an error.
  let result = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await requestTranslation(text, target, gloss);
    if (isValidTranslation(r.translation, text, target)) { result = r; break; }
  }
  if (!result) throw new Error(t('tr.invalid'));

  // Never cache an invalid result — only reached with a validated translation.
  try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch { /* quota full — skip */ }
  return result;
}

// Chat history: each entry is a whole conversation (a list of translations)
// shown as a single Recents / Pinned item. Guests keep it in localStorage;
// signed-in users in Supabase. Same row shape in both:
//   { chat_id, title, messages: [{ source_text, translation, tokens }], pinned, updated_at }
const LOCAL_HIST_KEY = 'shuazi-tr-chats';

function newChatId() {
  return crypto.randomUUID?.() || 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}
// The Recents preview label for a chat: its first message's source text.
function chatTitle(messages) {
  return messages[0]?.source_text || 'New chat';
}
function localChatsGet() {
  try { return JSON.parse(localStorage.getItem(LOCAL_HIST_KEY)) || []; } catch { return []; }
}
function localChatsSet(rows) {
  try { localStorage.setItem(LOCAL_HIST_KEY, JSON.stringify(rows)); } catch { /* quota full */ }
}
function sortHistory(rows) {
  return [...rows].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    String(b.updated_at).localeCompare(String(a.updated_at)));
}
function localChatUpsert(chat) {
  const rows = localChatsGet();
  const i = rows.findIndex(r => r.chat_id === chat.chat_id);
  if (i >= 0) rows[i] = { ...rows[i], ...chat };          // keep pinned & created order
  else rows.unshift({ pinned: false, ...chat });
  localChatsSet(rows.slice(0, 100));
}

// Persists the current chat (create or update in place, keyed by chat_id).
// Signed-in users sync to Supabase; guests fall back to localStorage. Pinned is
// never sent, so an autosave never clobbers a pin. Never throws.
async function saveChat(chat) {
  if (!state.supaUser) { localChatUpsert(chat); return; }
  try {
    await supa.from('chats').upsert({
      user_id:    state.supaUser.id,
      chat_id:    chat.chat_id,
      title:      chat.title,
      messages:   chat.messages,
      updated_at: chat.updated_at,
    }, { onConflict: 'user_id,chat_id' });
  } catch (e) {
    console.warn('Translator: could not save chat:', e);
  }
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

// Gives the browser/OS media UI the Shuazi logo (otherwise it shows a blank or
// generic icon when our TTS Audio element starts playing). Absolute icon paths
// so it resolves the same from any page.
function setMediaSession(text) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: text,
      artist: 'Shuazi',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch { /* MediaMetadata unsupported — ignore */ }
}

// Speaks Chinese text. Tries cloud TTS first, falls back to Web Speech on any
// failure. `onState` (optional) toggles UI feedback (true while playing).
export async function speak(text, onState) {
  if (!text) return;
  stopPlayback();
  onState?.(true);
  let cleared = false;
  const done = () => { if (!cleared) { cleared = true; onState?.(false); } };
  try {
    const url = await fetchTtsUrl(text);
    const audio = new Audio(url);
    setMediaSession(text);
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

// Speaks non-Chinese translations with the browser's Web Speech in the given
// locale (cloud TTS is Chinese-only). Picks a voice matching the language when the
// OS provides one, else lets the engine choose. `onState` toggles UI feedback.
export function speakInLang(text, speechLang, onState) {
  if (!('speechSynthesis' in window) || !text) { onState?.(false); return; }
  stopPlayback();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = speechLang;
  const base = speechLang.slice(0, 2).toLowerCase();
  const voice = speechSynthesis.getVoices().find(v => v.lang?.toLowerCase().startsWith(base));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  onState?.(true);
  u.onend = () => onState?.(false);
  u.onerror = () => onState?.(false);
  speechSynthesis.speak(u);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Tap-to-copy / edit popover (sent message bubbles) ───────────────────────
const COPY_ICON  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const EDIT_ICON  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

// Write text to the clipboard, with a fallback for older / insecure contexts.
async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

let openCopyPop = null;
function closeCopyPop() {
  if (!openCopyPop) return;
  const pop = openCopyPop;
  openCopyPop = null;
  document.removeEventListener('click', closeCopyPop);
  window.removeEventListener('scroll', closeCopyPop, { capture: true });
  window.removeEventListener('resize', closeCopyPop);
  pop.classList.remove('show');
  setTimeout(() => pop.remove(), 200);
}

// The sent message isn't text-selectable; tapping its bubble raises a small popover
// with Copy — and, when `onEdit` is given, Edit — instead of the native selection
// menu. Edit hands the text back to the composer to be corrected and re-sent.
function wireCopyPopover(bubbleEl, getText, onEdit) {
  bubbleEl.addEventListener('click', e => {
    e.stopPropagation();
    // A second tap on the same bubble dismisses; any other tap replaces the pop.
    const sameAnchor = openCopyPop && openCopyPop._anchor === bubbleEl;
    closeCopyPop();
    if (sameAnchor) return;

    const pop = document.createElement('div');
    pop.className = 'tr-copy-pop';
    pop._anchor = bubbleEl;
    pop.addEventListener('click', ev => ev.stopPropagation());   // tapping the pill never dismisses

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'tr-pop-btn';
    copyBtn.innerHTML = `${COPY_ICON}<span>${t('tr.copy')}</span>`;
    copyBtn.addEventListener('click', async () => {
      await copyToClipboard(getText());
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = `${CHECK_ICON}<span>${t('tr.copied')}</span>`;
      setTimeout(closeCopyPop, 750);
    });
    pop.appendChild(copyBtn);

    if (onEdit) {
      const sep = document.createElement('div');
      sep.className = 'tr-pop-sep';
      pop.appendChild(sep);
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tr-pop-btn';
      editBtn.innerHTML = `${EDIT_ICON}<span>${t('tr.edit')}</span>`;
      editBtn.addEventListener('click', () => { closeCopyPop(); onEdit(); });
      pop.appendChild(editBtn);
    }

    bubbleEl.closest('.tr-user-msg').appendChild(pop);
    openCopyPop = pop;
    requestAnimationFrame(() => pop.classList.add('show'));
    document.addEventListener('click', closeCopyPop);
    window.addEventListener('scroll', closeCopyPop, { capture: true, passive: true });
    window.addEventListener('resize', closeCopyPop);
  });
}

// Normalises the server tokens ({ zh, gloss }) into the render shape, computing
// pinyin per word locally. `gloss` is the literal per-word meaning (in the app's
// language) shown as a legend. Falls back to the legacy `en` key so tokens saved by
// older builds (in history / the localStorage cache) still show their glosses.
function tokensFromServer(tokens) {
  return tokens
    .filter(t => t && typeof t.zh === 'string' && t.zh.length)
    .map(t => {
      const origin = t.zh;
      const latin = !CJK_RE.test(origin) && WORD_RE.test(origin);
      const punct = !latin && PUNCT_RE.test(origin);
      const gloss = typeof t.gloss === 'string' ? t.gloss : (typeof t.en === 'string' ? t.en : '');
      return {
        origin,
        result: latin || punct ? '' : pinyin(origin),
        en: gloss,
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
        // Mark the word (gradient border) only while it plays; clear it once the
        // audio ends so nothing stays highlighted afterwards.
        resultEl.querySelectorAll('.tr-token.selected').forEach(t => t.classList.remove('selected'));
        el.classList.add('selected');
        speak(seg.origin, on => {
          el.classList.toggle('speaking', on);
          if (!on) el.classList.remove('selected');
        });
      });
    }
    resultEl.appendChild(el);
  }
}

let wired = false;

// Wires the DOM once and kicks off the lazy library load. Safe to call on
// every tab open — only the first call does work.
export function initTranslator() {
  const input        = document.getElementById('trInput');
  const button       = document.getElementById('trGo');
  const emptyEl       = document.getElementById('trEmpty');
  const countEl        = document.getElementById('trCount');
  const conversationEl = document.getElementById('trConversation');
  const msgTemplate    = document.getElementById('trMsgTemplate');
  const newChatBtn     = document.getElementById('trNewChat');
  const scrollEl       = document.querySelector('#screen-translator .translator-scroll');
  if (!input || !button) return;

  // Start loading the library as soon as the tab is first opened.
  ensureLibs().then(() => {
    button.disabled = false;
  });

  // The listen button only makes sense with speech synthesis available.
  const canSpeak = 'speechSynthesis' in window;

  if (wired) return;
  wired = true;

  // Scroll to the newest message (bottom of the conversation).
  const scrollToBottom = () => requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });

  // The chat currently on screen. Each translation is appended here and the whole
  // chat is saved as one Recents entry (keyed by chatId). `null` id = not yet
  // persisted; the first translation mints one.
  let chatId = null;
  let messages = [];
  // When set, the next submit re-translates and replaces this message in place
  // instead of appending a new one: { el: the .tr-message node, target }.
  let editing = null;

  // "New chat" only makes sense once there's something to clear — a message on
  // screen or text being typed. Hidden on an empty, fresh chat.
  const syncNewChatBtn = () => {
    if (!newChatBtn) return;
    const hasContent = conversationEl.children.length > 0 || input.value.trim() !== '';
    newChatBtn.style.display = hasContent ? '' : 'none';
  };

  // Starts a fresh conversation: clears the on-screen messages and the input.
  // The previous chat is already saved, so it just becomes a Recents entry.
  function newChat() {
    stopPlayback();
    conversationEl.innerHTML = '';
    emptyEl.style.display = 'none';
    input.value = '';
    chatId = null;
    messages = [];
    editing = null;
    if (editBanner) editBanner.style.display = 'none';
    autoGrow(); syncCount(); syncNewChatBtn(); updateComposerMode();
  }

  // "New chat" archives the current conversation (already saved to Recents) and
  // opens a fresh one. To make that legible, a fixed-position clone of the messages
  // flies up into the Recents icon (which pulses) while the real chat resets
  // underneath instantly. The clone lives on <body> so the scroller can't clip it
  // as it crosses into the header.
  function archiveToRecents() {
    const histBtn = document.getElementById('trHistoryBtn');
    if (!histBtn || !conversationEl.children.length) { newChat(); return; }

    const from = conversationEl.getBoundingClientRect();
    const to   = histBtn.getBoundingClientRect();
    const PAD  = 10;   // card inset; the fly grows by this so its content stays put

    const fly = document.createElement('div');
    fly.className = 'tr-archive-fly';
    fly.style.left  = (from.left - PAD) + 'px';
    fly.style.top   = (from.top  - PAD) + 'px';
    fly.style.width = (from.width + PAD * 2) + 'px';
    // Tall chats become a capped preview card with a soft bottom fade.
    if (from.height > window.innerHeight * 0.44) fly.classList.add('clipped');
    fly.appendChild(conversationEl.cloneNode(true));
    document.body.appendChild(fly);

    newChat();   // reset the real conversation now — the fresh chat is already visible
    buzz?.(12);  // subtle haptic tick, iOS-style

    // Spring the card up (anticipation) then let it decelerate into the Recents icon
    // — a two-phase iOS-like "pick up and file away". Origin top-centre → it collapses
    // upward as it shrinks. Web Animations API so each leg can have its own easing.
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top  + to.height / 2) - (from.top - PAD);
    const anim = fly.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: 'translate(0,-12px) scale(1.03)', opacity: 1, offset: .18, easing: 'cubic-bezier(.34,1.56,.64,1)' },
      { transform: `translate(${dx}px, ${dy}px) scale(.06)`, opacity: 0, easing: 'cubic-bezier(.5,0,.15,1)' },
    ], { duration: 600, fill: 'forwards' });
    anim.onfinish = () => fly.remove();

    // Spring pop on the icon as the card lands.
    setTimeout(() => {
      histBtn.classList.add('tr-recents-pulse');
      setTimeout(() => histBtn.classList.remove('tr-recents-pulse'), 520);
    }, 380);
  }

  newChatBtn?.addEventListener('click', () => {
    conversationEl.children.length ? archiveToRecents() : newChat();
  });

  // Like newChat, but also deletes the current chat from Recents (used by the
  // pull-to-refresh gesture — a pull discards the whole conversation).
  async function discardChat() {
    const id = chatId;
    // Glide the messages up and fade them before wiping, so the clear feels smooth
    // rather than an abrupt disappearance.
    if (conversationEl.children.length) {
      conversationEl.classList.add('clearing');
      await new Promise(r => setTimeout(r, 300));
    }
    newChat();                              // clears the (now invisible) messages
    conversationEl.classList.remove('clearing');   // reset — empty, so no flash
    if (!id) return;
    if (!state.supaUser) {
      localChatsSet(localChatsGet().filter(x => x.chat_id !== id));
    } else {
      try { await supa.from('chats').delete().eq('user_id', state.supaUser.id).eq('chat_id', id); } catch {}
    }
    if (document.body.classList.contains('recents-open')) loadHistory();
  }

  // Builds one chat message node without inserting it, so callers can append it or
  // swap it in place for an edited message. For Chinese it's the rich layout
  // (Original / Hanzi / Tokens); other targets drop the tokenized block and use
  // Web Speech for TTS.
  function buildMessageEl(original, translation, tokens, target = 'zh') {
    const isZh = target === 'zh';
    const msg = msgTemplate.content.firstElementChild.cloneNode(true);
    applyStaticTranslations(msg);   // localize the cloned section titles
    const originalEl = msg.querySelector('.js-original');
    const zhLineEl   = msg.querySelector('.js-zh');
    const resultEl   = msg.querySelector('.js-result');
    const speakBtn   = msg.querySelector('.js-speak');
    const copyBtn    = msg.querySelector('.js-copy');
    const eyeBtn     = msg.querySelector('.js-eye');

    originalEl.textContent = original;
    zhLineEl.textContent   = translation;

    // The sent bubble isn't text-selectable — tap it for a Copy / Edit popover.
    wireCopyPopover(originalEl, () => original, () => startEdit(msg, original, target));

    if (isZh) {
      renderTokens(translation, tokens, resultEl);
    } else {
      // Plain translation: drop the tokenized block (there's no title to relabel).
      resultEl.closest('.tr-section')?.remove();
    }

    // Listen to the translated sentence: cloud TTS for Chinese, Web Speech otherwise.
    if (canSpeak) {
      speakBtn.addEventListener('click', () => {
        const cb = on => speakBtn.classList.toggle('playing', on);
        if (isZh) speak(zhLineEl.textContent, cb);
        else      speakInLang(zhLineEl.textContent, (TR_LANGS[target] || TR_LANGS.zh).speech, cb);
      });
    } else {
      speakBtn.style.display = 'none';
    }

    // Copy the Hanzi translation to the clipboard, with a brief checkmark.
    let copiedTimer = null;
    copyBtn.addEventListener('click', async () => {
      const text = zhLineEl.textContent;
      if (!text) return;
      await copyToClipboard(text);
      copyBtn.classList.add('copied');
      copyBtn.blur();   // drop focus/active so no pressed state lingers on touch
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => copyBtn.classList.remove('copied'), 600);
    });

    // The eye reveals / hides every English gloss in this message at once; hide
    // it entirely when there are no glosses to reveal.
    if (resultEl.querySelector('.en')) {
      eyeBtn.addEventListener('click', () => {
        const showing = eyeBtn.classList.toggle('showing');
        resultEl.querySelectorAll('.tr-token').forEach(t => {
          if (t.querySelector('.en')) t.classList.toggle('revealed', showing);
        });
      });
    } else {
      eyeBtn.style.display = 'none';
    }

    return msg;
  }

  function appendMessage(original, translation, tokens, target = 'zh') {
    const msg = buildMessageEl(original, translation, tokens, target);
    emptyEl.style.display = 'none';
    conversationEl.appendChild(msg);
    scrollToBottom();
    syncNewChatBtn();
    return msg;
  }

  // A pending message: the sent bubble shown instantly, with three "thinking" dots
  // where the translation will go. The resolved message replaces the whole node.
  function makePendingEl(original) {
    const msg = msgTemplate.content.firstElementChild.cloneNode(true);
    const originalEl = msg.querySelector('.js-original');
    originalEl.textContent = original;
    wireCopyPopover(originalEl, () => original);   // copy only while it loads
    // Drop the (empty) translation sections; show the thinking dots in their place.
    msg.querySelectorAll('.tr-section').forEach(s => s.remove());
    const thinking = document.createElement('div');
    thinking.className = 'tr-thinking';
    thinking.innerHTML = '<span></span><span></span><span></span>';
    msg.appendChild(thinking);
    return msg;
  }

  // ── EDIT A SENT MESSAGE ──
  // A small banner in the composer signals edit mode and offers a way out.
  const composerEl = input.closest('.tr-composer');
  const editBanner = document.createElement('div');
  editBanner.className = 'tr-edit-banner';
  editBanner.style.display = 'none';
  editBanner.innerHTML = `<span class="js-editing-label">${t('tr.editing')}</span>` +
    `<button type="button" class="tr-edit-cancel" aria-label="${t('tr.cancel')}">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
  composerEl?.insertBefore(editBanner, composerEl.firstChild);
  editBanner.querySelector('.tr-edit-cancel').addEventListener('click', () => cancelEdit());

  // Load a sent message's text back into the composer to be corrected and re-sent.
  function startEdit(msgEl, original, target) {
    editing = { el: msgEl, target };
    conversationEl.querySelectorAll('.tr-message.editing').forEach(m => m.classList.remove('editing'));
    msgEl.classList.add('editing');
    editBanner.querySelector('.js-editing-label').textContent = t('tr.editing');
    editBanner.querySelector('.tr-edit-cancel').setAttribute('aria-label', t('tr.cancel'));
    editBanner.style.display = '';
    input.value = original;
    autoGrow(); syncCount(); syncNewChatBtn(); updateComposerMode();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function cancelEdit() {
    if (editing) editing.el.classList.remove('editing');
    editing = null;
    editBanner.style.display = 'none';
    input.value = '';
    autoGrow(); syncCount(); syncNewChatBtn(); updateComposerMode();
  }

  async function handleSubmit() {
    const text = input.value.trim();
    if (!text) return;
    const editCtx = editing;   // capture: this submit is an edit iff set
    emptyEl.style.display = 'none';
    button.disabled = true;
    button.classList.add('tr-loading');
    // Clear the box right after sending (chat-style); it reappears as a message.
    input.value = '';
    editing = null;
    editBanner.style.display = 'none';
    autoGrow(); syncCount(); updateComposerMode();

    // Show the sent message instantly with thinking dots where the translation
    // will go: an edit swaps it into the edited slot, a new send appends it.
    const idx = editCtx ? [...conversationEl.children].indexOf(editCtx.el) : -1;
    const pendingEl = makePendingEl(text);
    if (editCtx && idx >= 0) {
      conversationEl.replaceChild(pendingEl, editCtx.el);
    } else {
      conversationEl.appendChild(pendingEl);
      syncNewChatBtn();
      scrollToBottom();
    }
    try {
      // An edit keeps the message's original output language; new sends use the picker.
      const target = editCtx ? editCtx.target : trTarget;
      // pinyin-pro is only needed for the Chinese (tokenized) path.
      if (target === 'zh') await ensureLibs();
      const { translation: zh, tokens } = await translate(text, target);
      // Skip if the pending message was cleared meanwhile (e.g. a new chat opened).
      if (!pendingEl.parentNode) return;
      const row = { source_text: text, translation: zh, tokens: tokens ?? null, target };
      // Replace the dots with the resolved translation, in the same slot and state.
      conversationEl.replaceChild(buildMessageEl(text, zh, tokens, target), pendingEl);
      if (editCtx && idx >= 0) messages[idx] = row; else messages.push(row);
      if (!editCtx) scrollToBottom();
      // Append to the current chat and save the whole conversation as one entry.
      if (!chatId) chatId = newChatId();
      saveChat({ chat_id: chatId, title: chatTitle(messages), messages, updated_at: new Date().toISOString() })
        .then(() => { if (document.body.classList.contains('recents-open')) loadHistory(); });
    } catch (e) {
      console.error(e);
      // Translation failed: restore the original message on an edit, or drop the
      // pending bubble on a new send — then surface the error.
      if (pendingEl.parentNode) {
        if (editCtx && idx >= 0) { editCtx.el.classList.remove('editing'); conversationEl.replaceChild(editCtx.el, pendingEl); }
        else pendingEl.remove();
      }
      emptyEl.textContent = t('tr.error') + e.message;
      emptyEl.className = 'tr-empty err';
      emptyEl.style.display = 'block';
      scrollToBottom();
    } finally {
      button.classList.remove('tr-loading');
      button.disabled = false;
    }
  }

  button.addEventListener('click', handleSubmit);
  // Enter inserts a newline (default textarea behaviour) — translate only via the
  // send button, so a return never fires a translation.

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
  // Keep the (optional) character counter in sync with the input.
  const syncCount = () => {
    if (countEl) countEl.textContent = input.value.length;
  };

  // ── ONE-ROW ↔ TWO-ROW COMPOSER ──
  // Switch to the two-row layout once the text no longer fits a single row (or has a
  // newline). The check measures the text against the *single-row* available width
  // via a hidden mirror, so it's independent of the current layout and can't
  // oscillate (widening the box could otherwise make the text fit again → flip-flop).
  const toolsEl = inputField.querySelector('.tr-input-tools');
  const langEl  = document.getElementById('trLang');
  const measurer = document.createElement('span');
  measurer.setAttribute('aria-hidden', 'true');
  measurer.style.cssText = 'position:absolute;left:-9999px;top:-9999px;white-space:pre;visibility:hidden;pointer-events:none;';
  document.body.appendChild(measurer);
  const singleRowTextWidth = () => {
    const fCS = getComputedStyle(inputField);
    const fieldContent = inputField.clientWidth - parseFloat(fCS.paddingLeft) - parseFloat(fCS.paddingRight);
    const iCS = getComputedStyle(input);
    const inputPad = parseFloat(iCS.paddingLeft) + parseFloat(iCS.paddingRight);
    const controls = (langEl?.offsetWidth || 0) + (toolsEl?.offsetWidth || 0) + 6; // + bar gap
    return fieldContent - 6 /* field↔bar gap */ - controls - inputPad;
  };
  const updateComposerMode = () => {
    const val = input.value;
    let multi = val.includes('\n');
    if (!multi && val) {
      const iCS = getComputedStyle(input);
      measurer.style.fontFamily    = iCS.fontFamily;
      measurer.style.fontSize      = iCS.fontSize;
      measurer.style.fontWeight    = iCS.fontWeight;
      measurer.style.letterSpacing = iCS.letterSpacing;
      measurer.textContent = val;
      multi = measurer.offsetWidth > singleRowTextWidth() - 4;   // -4: small margin
    }
    inputField.classList.toggle('multiline', multi);
  };

  input.addEventListener('input', () => { updateComposerMode(); autoGrow(); syncCount(); syncNewChatBtn(); });
  syncCount();
  syncNewChatBtn();       // hidden on the initial empty chat
  updateComposerMode();   // start in single-row for the empty chat
  window.addEventListener('resize', updateComposerMode);

  wireMic(input, () => { updateComposerMode(); autoGrow(); syncCount(); syncNewChatBtn(); });

  // ── TAP EFFECT (ChatGPT-style: soft & sophisticated) ──
  // Every tap on the bar makes it breathe (a barely-there scale, no overshoot) and
  // sends a soft luminous bloom out from the touch point. One-shot, replays per tap.
  const rippleLayer = document.createElement('div');
  rippleLayer.className = 'tr-ripple-layer';
  rippleLayer.setAttribute('aria-hidden', 'true');
  inputField.appendChild(rippleLayer);
  inputField.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;   // buttons have their own feedback

    // Gentle breath — subtle, smooth, no overshoot.
    inputField.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.015)', offset: .5 }, { transform: 'scale(1)' }],
      { duration: 540, easing: 'cubic-bezier(.4,0,.2,1)' }
    );

    // Soft luminous bloom from the tapped point.
    const r = inputField.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'tr-ripple';
    const size = Math.max(r.width, r.height) * 1.25;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - r.left) + 'px';
    ripple.style.top  = (e.clientY - r.top) + 'px';
    const remove = () => ripple.remove();       // idempotent
    ripple.addEventListener('animationend', remove);
    setTimeout(remove, 1100);                   // fallback so a node can never leak
    rippleLayer.appendChild(ripple);
  });

  // ── OUTPUT LANGUAGE PICKER ──
  // A subtle language-code button (zh / en / es) on the left of the composer opens
  // a little popover above it. Chinese keeps the full tokenized mode; other targets
  // get a plain translation (see appendMessage). The button label always shows the
  // current output language, so the choice is discoverable at a glance.
  const langBtn  = document.getElementById('trLang');
  const langCode = document.getElementById('trLangCode');
  if (langBtn) {
    const langMenu = document.createElement('div');
    langMenu.className = 'tr-lang-menu';
    langMenu.innerHTML = Object.entries(TR_LANGS)
      .map(([code, { label }]) => `<button type="button" class="tr-lang-opt" data-lang="${code}">${label}</button>`)
      .join('');
    // Anchor it inside the input bar (position:absolute in CSS), so it stays glued
    // to the bar and moves with it — fixed positioning drifts when the on-screen
    // keyboard shifts the visual viewport.
    (langBtn.closest('.tr-input-field') || document.body).appendChild(langMenu);

    // Reflect the current target in the composer code and the header subtitle
    // ("Any language → <language>"). The subtitle prefix is localized separately
    // via data-i18n, so we only own the language name here.
    const subLang = document.getElementById('trSubLang');
    const syncBtn = () => {
      const label = TR_LANGS[getTrTarget()].label;
      if (langCode) langCode.textContent = getTrTarget();
      if (subLang)  subLang.textContent  = label;
    };
    syncBtn();

    const closeLangMenu = () => { langMenu.classList.remove('open'); langBtn.classList.remove('open'); };
    const openLangMenu = () => {
      langMenu.querySelectorAll('.tr-lang-opt').forEach(o => o.classList.toggle('active', o.dataset.lang === getTrTarget()));
      langMenu.classList.add('open');
      langBtn.classList.add('open');
    };

    langBtn.addEventListener('click', () => {
      langMenu.classList.contains('open') ? closeLangMenu() : openLangMenu();
    });
    langMenu.addEventListener('click', e => {
      const opt = e.target.closest('.tr-lang-opt');
      if (!opt) return;
      setTrTarget(opt.dataset.lang);
      syncBtn();
      closeLangMenu();
    });
    document.addEventListener('pointerdown', e => {
      if (langMenu.classList.contains('open') && !langMenu.contains(e.target) && !langBtn.contains(e.target)) closeLangMenu();
    }, true);
    window.addEventListener('resize', closeLangMenu);
  }

  // ── HISTORY DRAWER ──
  const historyBtn      = document.getElementById('trHistoryBtn');
  const historyPanel    = document.getElementById('trHistory');
  const historyClose    = document.getElementById('trHistoryClose');
  const historyBackdrop = document.getElementById('trHistoryBackdrop');
  const historyList     = document.getElementById('trHistoryList');

  // Context menu (ChatGPT-style): a little popup with a red Delete action.
  const menu = document.createElement('div');
  menu.className = 'tr-menu';
  menu.innerHTML =
    `<button class="tr-menu-pin" type="button">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
       <span class="tr-menu-pin-label">Pin</span>
     </button>
     <button class="tr-menu-del" type="button">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
       <span>Delete</span>
     </button>`;
  document.body.appendChild(menu);
  const pinLabel = menu.querySelector('.tr-menu-pin-label');
  let menuRow = null, menuItem = null;

  function openMenu(x, y, row, item) {
    menuRow = row; menuItem = item;
    pinLabel.textContent = row.pinned ? 'Unpin' : 'Pin';
    item.classList.add('selected');
    menu.style.left = '0px'; menu.style.top = '0px';
    menu.classList.add('open');
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth  - w - 8) + 'px';
    menu.style.top  = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  function closeMenu() {
    menu.classList.remove('open');
    if (menuItem) menuItem.classList.remove('selected');
    menuItem = null; menuRow = null;
  }
  menu.querySelector('.tr-menu-pin').addEventListener('click', async () => {
    const row = menuRow;
    closeMenu();
    if (!row) return;
    if (!state.supaUser) {
      const rows = localChatsGet();
      const r = rows.find(x => x.chat_id === row.chat_id);
      if (r) { r.pinned = !r.pinned; localChatsSet(rows); }
      loadHistory();
      return;
    }
    try {
      await supa.from('chats')
        .update({ pinned: !row.pinned })
        .eq('user_id', state.supaUser.id).eq('chat_id', row.chat_id);
    } catch {}
    loadHistory();   // reorder (pinned first)
  });
  menu.querySelector('.tr-menu-del').addEventListener('click', async () => {
    const row = menuRow, item = menuItem;
    closeMenu();
    if (!row) return;
    if (!state.supaUser) {
      localChatsSet(localChatsGet().filter(x => x.chat_id !== row.chat_id));
    } else {
      try { await supa.from('chats').delete().eq('user_id', state.supaUser.id).eq('chat_id', row.chat_id); } catch {}
    }
    // If the deleted chat is the one on screen, start a fresh one.
    if (row.chat_id === chatId) newChat();
    item?.remove();
    if (!historyList.querySelector('.tr-history-item')) renderHistory([]);
  });
  document.addEventListener('pointerdown', e => {
    if (menu.classList.contains('open') && !menu.contains(e.target)) closeMenu();
  }, true);
  historyList.addEventListener('scroll', () => { if (menu.classList.contains('open')) closeMenu(); });

  const isOpen = () => document.body.classList.contains('recents-open');

  // Haptics: the Web Vibration API on Android/Chrome; on iOS Safari (which has
  // no Vibration API) fall back to toggling a hidden <input switch>, which fires
  // the system haptic (iOS 17.4+). Intensity isn't controllable on iOS.
  let _hapticEl = null;
  const buzz = (ms = 15) => {
    if (navigator.vibrate?.(ms)) return;          // Android / Chrome
    try {
      if (!_hapticEl) {
        const label = document.createElement('label');
        label.setAttribute('aria-hidden', 'true');
        label.style.cssText = 'position:absolute;width:0;height:0;opacity:0;overflow:hidden;pointer-events:none';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('switch', '');         // Safari-only haptic switch
        label.appendChild(input);
        document.body.appendChild(label);
        _hapticEl = label;
      }
      _hapticEl.click();                           // toggling fires the iOS haptic
    } catch { /* no haptics available */ }
  };
  function openHistory()  { if (!isOpen()) buzz(); document.body.classList.add('recents-open'); historyPanel.setAttribute('aria-hidden', 'false'); loadHistory(); }
  function closeHistory() { document.body.classList.remove('recents-open'); historyPanel.setAttribute('aria-hidden', 'true'); }

  async function loadHistory() {
    if (!state.supaUser) { renderHistory(sortHistory(localChatsGet())); return; }
    try {
      const { data } = await supa
        .from('chats')
        .select('chat_id, title, messages, pinned, updated_at')
        .eq('user_id', state.supaUser.id)
        .order('pinned', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(100);
      renderHistory(data || []);
    } catch (e) {
      console.warn('Translator: could not load history:', e);
      renderHistory([]);
    }
  }

  function makeHistoryItem(row) {
    const item = document.createElement('div');
    item.className = 'tr-history-item' + (row.pinned ? ' pinned' : '');
    const preview = row.messages?.[0]?.translation || '';
    item.innerHTML =
      `<button class="tr-history-open" type="button">
         <span class="tr-history-src">${row.pinned ? '<svg class="tr-history-pin" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3a1 1 0 0 1 0 2 1 1 0 0 0-1 1v4.76a4 4 0 0 0 2.21 3.58l1.79.9V16H5v-.76l1.79-.9A4 4 0 0 0 9 10.76V6a1 1 0 0 0-1-1 1 1 0 0 1 0-2z"/></svg>' : ''}${escapeHtml(row.title || '')}</span>
         <span class="tr-history-zh">${escapeHtml(preview)}</span>
       </button>`;
    const openBtn = item.querySelector('.tr-history-open');

    // Long-press to reveal the context menu (Pin / Delete).
    let lpTimer = null, longPressed = false;
    const clearLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } item.classList.remove('pressing'); };
    openBtn.addEventListener('pointerdown', e => {
      longPressed = false;
      item.classList.add('pressing');
      const px = e.clientX, py = e.clientY;
      lpTimer = setTimeout(() => {
        longPressed = true;
        item.classList.remove('pressing');
        buzz(30);
        openMenu(px, py, row, item);
      }, 450);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(ev => openBtn.addEventListener(ev, clearLP));
    openBtn.addEventListener('click', e => {
      if (longPressed) { e.preventDefault(); longPressed = false; return; }   // long-press → don't open
      openFromHistory(row);
    });
    return item;
  }

  async function clearPinned() {
    if (!state.supaUser) {
      localChatsSet(localChatsGet().filter(r => !r.pinned));
    } else {
      try { await supa.from('chats').delete().eq('user_id', state.supaUser.id).eq('pinned', true); } catch {}
    }
    loadHistory();
  }

  async function clearRecents() {
    if (!state.supaUser) {
      localChatsSet(localChatsGet().filter(r => r.pinned));
    } else {
      try { await supa.from('chats').delete().eq('user_id', state.supaUser.id).eq('pinned', false); } catch {}
    }
    loadHistory();
  }

  function renderHistory(rows) {
    rows = rows || [];
    historyList.innerHTML = '';
    const pinned  = rows.filter(r => r.pinned);
    const recents = rows.filter(r => !r.pinned);
    const section = (label, onClear) => {
      const h = document.createElement('div');
      h.className = 'tr-history-section';
      h.innerHTML = `<span>${label}</span>`;
      if (onClear) {
        const btn = document.createElement('button');
        btn.className = 'tr-section-clear';
        btn.type = 'button';
        btn.textContent = t('history.clear');
        btn.addEventListener('click', onClear);
        h.appendChild(btn);
      }
      historyList.appendChild(h);
    };
    // Pinned and Recents headers always show; the empty message lives in Recents.
    section(t('history.pinned'), pinned.length ? clearPinned : null);
    pinned.forEach(r => historyList.appendChild(makeHistoryItem(r)));
    section(t('history.recents'), recents.length ? clearRecents : null);
    if (recents.length) {
      recents.forEach(r => historyList.appendChild(makeHistoryItem(r)));
    } else {
      const empty = document.createElement('div');
      empty.className = 'tr-history-empty';
      empty.textContent = t('history.empty');
      historyList.appendChild(empty);
    }
  }

  // Loads a whole chat back onto the screen and adopts it as the current one, so
  // further translations continue appending to it.
  async function openFromHistory(row) {
    emptyEl.textContent = ''; emptyEl.className = 'tr-empty'; emptyEl.style.display = 'none';
    closeHistory();
    await ensureLibs();
    stopPlayback();
    conversationEl.innerHTML = '';
    chatId = row.chat_id;
    messages = (row.messages || []).map(m => ({ ...m }));
    // Older saved messages have no target — they were Chinese.
    messages.forEach(m => appendMessage(m.source_text, m.translation, m.tokens, m.target || 'zh'));
  }

  historyBtn?.addEventListener('click', openHistory);
  historyClose?.addEventListener('click', closeHistory);
  historyBackdrop?.addEventListener('click', closeHistory);

  // iPhone-style interactive drag: the app content tracks the finger (push).
  // Swipe right anywhere to pull Recents in; drag left to push it back out.
  // On release it snaps open or closed depending on how far it was dragged.
  const trScreen = document.getElementById('screen-translator');
  const rootEl   = document.querySelector('.root');
  let startX = 0, startY = 0, width = 300, active = false, locked = false, mode = null, opened = false;

  const setDrag = px => {                       // px: content offset, 0..width
    document.body.classList.add('recents-dragging');
    rootEl.style.transform = `translateX(${px}px)`;
  };
  const settle = open => {
    if (open && !isOpen()) buzz();          // mini-buzz when it opens
    document.body.classList.remove('recents-dragging');
    document.body.classList.toggle('recents-open', open);
    historyPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    rootEl.style.transform = '';
  };

  document.addEventListener('touchstart', e => {
    // The tour owns horizontal swipes while it's open — don't pull in Recents.
    if (document.body.classList.contains('tour-active')) { active = false; return; }
    // Nor should a swipe pull in Recents while a modal sheet is open.
    if (document.querySelector('.modal-backdrop.open')) { active = false; return; }
    opened = isOpen();
    // Only engage on the translator tab (to open), or whenever it's already open (to close).
    if (e.touches.length !== 1 || (!opened && !trScreen.classList.contains('active'))) { active = false; return; }
    // Don't hijack the tab-bar pill drag or text selection in the input.
    if (e.target.closest('.tabbar, .tr-input')) { active = false; return; }
    // When text is selected, let the native selection handles be dragged freely
    // (extend/shrink the selection) instead of stealing the gesture to open Recents.
    const sel = window.getSelection();
    if (!opened && sel && !sel.isCollapsed) { active = false; return; }
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    // Content shift = panel width minus the 30px underlap (see CSS).
    width  = (historyPanel.offsetWidth || 330) - 30;
    active = true; locked = false; mode = null;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!active) return;
    const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
    if (!locked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { active = false; return; }   // vertical → let it scroll
      if (opened) { mode = 'close'; }
      else { if (dx <= 0) { active = false; return; } mode = 'open'; loadHistory(); }
      locked = true;
    }
    const base = opened ? width : 0;
    setDrag(Math.max(0, Math.min(width, base + dx)));
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!active || !locked) { active = false; return; }
    active = false;
    const dx = e.changedTouches[0].clientX - startX;
    if (mode === 'open') settle(dx > width * 0.35);
    else                 settle(dx > -width * 0.35);   // keep open unless dragged far left
  }, { passive: true });

  // ── PULL-TO-REFRESH ──
  // Dragging down from the very top of the conversation discards the current
  // chat — clears the on-screen messages and removes it from Recents — with a
  // native-style refresh disc.
  setupPullRefresh({
    scroll:    trScreen.querySelector('.translator-scroll'),
    disc:      document.getElementById('trPull'),
    content:   document.getElementById('trContent'),
    onRefresh: discardChat,
    exitUp:    true,    // wheel + caption glide up and fade with the cleared messages
    haptic:    buzz,    // buzz() handles iOS (no Vibration API) via the haptic switch
    // A longer, harder pull than the default so it isn't triggered by accident.
    trigger:   96,
    max:       132,
    damp:      120,
    label:     document.getElementById('trPullLabel'),
    pullText:  () => t('tr.pullClear'),
    readyText: () => t('tr.releaseClear'),
  });
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

  // Auto-stop on silence (energy-based VAD with an adaptive threshold — the usual
  // industry approach; a fixed RMS is unreliable across mics/environments):
  //   • calibrate the ambient noise floor for the first CALIBRATION_MS,
  //   • speech = level a margin above that floor (held long enough to skip clicks),
  //   • end the utterance after SILENCE_MS of trailing silence (~1s, like Google/Alexa),
  //   • MAX_RECORD_MS is a hard cap on a single utterance.
  let audioCtx = null, silenceRAF = 0;
  const CALIBRATION_MS = 350;
  const SPEECH_MIN_MS  = 120;    // sustained energy before it counts as speech
  const SILENCE_MS     = 1000;   // trailing silence that ends the utterance
  const MAX_RECORD_MS  = 30000;  // safety cap
  function watchSilence() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume?.();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const t0 = performance.now();
      let noiseSum = 0, noiseN = 0, threshold = 0.02;
      let hasSpoken = false, silenceStart = 0, speechRun = 0, last = t0;

      const tick = () => {
        if (!recording) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now(), dt = now - last; last = now;

        if (now - t0 > MAX_RECORD_MS) { recorder.stop(); return; }

        if (now - t0 < CALIBRATION_MS) {                 // learn the ambient floor
          noiseSum += rms; noiseN++;
          threshold = Math.min(0.06, Math.max(0.015, (noiseSum / noiseN) * 2.8 + 0.008));
        } else if (rms > threshold) {                    // energy present
          speechRun += dt;
          if (speechRun >= SPEECH_MIN_MS) hasSpoken = true;
          silenceStart = 0;
        } else {                                         // below threshold
          speechRun = 0;
          if (hasSpoken) {
            if (!silenceStart) silenceStart = now;
            else if (now - silenceStart > SILENCE_MS) { recorder.stop(); return; }
          }
        }
        silenceRAF = requestAnimationFrame(tick);
      };
      silenceRAF = requestAnimationFrame(tick);
    } catch (e) { /* Web Audio unavailable — manual stop still works */ }
  }
  function stopSilenceWatch() {
    if (silenceRAF) cancelAnimationFrame(silenceRAF);
    silenceRAF = 0;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }

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
      recording = false;
      stopSilenceWatch();
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size) transcribe(blob); else setState('idle');
    };
    recorder.start();
    recording = true;
    setState('recording');
    watchSilence();   // auto-stop on silence once the user has spoken
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
