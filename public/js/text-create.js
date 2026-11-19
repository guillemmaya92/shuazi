import { t, applyStaticTranslations } from './i18n.js';
import { state } from './state.js';
import { SUPA_URL, hskLabel, supa } from './config.js';

/* ── TEXTS: create a new passage from a photo ──
   Flow: fill title / HSK / source, pick one or more photos (pages in order) →
   "Process" sends them to the
   `text-import` Edge Function (OCR → DeepSeek tokenizes + translates, keeping the
   original punctuation) → preview → "Upload" inserts the row into `texts`. */

const MAX_SIDE = 1600;       // longest image side sent to the server (px)
const JPEG_QUALITY = 0.8;    // several photos go in one request, so keep each one light
const MAX_PHOTOS = 5;        // must match the Edge Function

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HAN = /\p{Script=Han}/u;

let onCreated = () => {};
let built = false;
let els = {};
let result = null;      // processed passage, ready to insert
let busy = false;
// Selected photos in send order (file picker and/or camera). Each one is read and
// downscaled to a data URL as soon as it is added, so the thumbnail and the upload
// never depend on the original File or on a temporary blob: URL (adding the same
// image twice used to leave a broken thumbnail).
let photos = [];        // [{ id, dataUrl }]
let photoSeq = 0;
let addQueue = Promise.resolve();   // keeps adds in the order they were attached

// Downscale + re-encode the photo so phone pictures stay well under the size limit.
async function fileToDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

const INPUT_CSS = 'width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--bdr);border-radius:12px;padding:10px 12px;font:inherit;font-size:.82rem;color:var(--txt);outline:none';
const LABEL_CSS = 'display:flex;flex-direction:column;gap:5px;font-size:.68rem;font-weight:600;color:var(--muted)';
const PRIMARY_CSS = 'padding:12px;border-radius:12px;background:var(--blue);border:1px solid var(--blue);color:#fff;font-size:.82rem;font-weight:700;cursor:pointer';
const SECONDARY_CSS = 'padding:12px;border-radius:12px;background:var(--surf);border:1px solid var(--bdr);color:var(--muted);font-size:.82rem;font-weight:600;cursor:pointer';

function build() {
  if (built) return;
  built = true;
  const levels = [1, 2, 3, 4, 5, 6, 7].map(n => `<option value="${n}">${esc(hskLabel(n))}</option>`).join('');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.id = 'newtext-backdrop';
  wrap.innerHTML = `
    <div class="modal" id="newtext-modal" role="dialog" aria-modal="true" aria-labelledby="newtextHead" style="gap:12px">
      <div class="modal-handle"></div>
      <div id="newtextHead" data-i18n="texts.newTitle" style="font-size:.95rem;font-weight:700;color:var(--txt);text-align:center">${esc(t('texts.newTitle'))}</div>
      <label style="${LABEL_CSS}"><span data-i18n="texts.fTitle">${esc(t('texts.fTitle'))}</span>
        <input id="ntTitle" type="text" style="${INPUT_CSS}" autocomplete="off" lang="zh" placeholder="图书馆在哪儿">
      </label>
      <div style="display:flex;gap:10px">
        <label style="${LABEL_CSS};flex:0 0 38%"><span data-i18n="texts.fHsk">${esc(t('texts.fHsk'))}</span>
          <select id="ntHsk" style="${INPUT_CSS}">${levels}</select>
        </label>
        <label style="${LABEL_CSS};flex:1;min-width:0"><span data-i18n="texts.fSource">${esc(t('texts.fSource'))}</span>
          <input id="ntSource" type="text" style="${INPUT_CSS}" autocomplete="off">
        </label>
      </div>
      <div id="ntPhotoGroup" style="${LABEL_CSS}">
        <label for="ntPhoto" data-i18n="texts.fPhoto">${esc(t('texts.fPhoto'))}</label>
        <div style="display:flex;align-items:center;gap:8px">
            <input id="ntPhoto" type="file" accept="image/*" multiple style="${INPUT_CSS};flex:1;min-width:0;width:auto">
          <button id="ntCameraBtn" type="button" data-i18n-aria="texts.camera" data-i18n-title="texts.camera" aria-label="${esc(t('texts.camera'))}" title="${esc(t('texts.camera'))}" style="flex:0 0 auto;width:36px;height:36px;padding:0;border-radius:50%;background:var(--surf);border:1px solid var(--bdr);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
        </div>
        <input id="ntCamera" type="file" accept="image/*" capture="environment" hidden>
      </div>
      <div id="ntCamPanel" style="display:none;flex-direction:column;gap:8px">
        <video id="ntVideo" autoplay playsinline muted style="width:100%;max-height:45dvh;background:#000;border-radius:12px;object-fit:contain"></video>
        <div style="display:flex;gap:8px">
          <button id="ntShot" type="button" data-i18n="texts.capture" style="${PRIMARY_CSS};flex:1">${esc(t('texts.capture'))}</button>
          <button id="ntCamClose" type="button" data-i18n="texts.closeCamera" style="${SECONDARY_CSS};flex:1">${esc(t('texts.closeCamera'))}</button>
        </div>
      </div>
      <div id="ntThumbs" style="display:none;flex-direction:column;gap:4px"></div>
      <div id="ntResult" style="display:none"></div>
      <div id="ntMsg" role="status" aria-live="polite" style="font-size:.72rem;text-align:center;min-height:.9rem"></div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="ntProcess" type="button" data-i18n="texts.process" style="${PRIMARY_CSS}">${esc(t('texts.process'))}</button>
        <button id="ntUpload" type="button" data-i18n="texts.upload" style="${PRIMARY_CSS};background:var(--green);border-color:var(--green);display:none">${esc(t('texts.upload'))}</button>
        <button id="ntCancel" type="button" data-i18n="common.cancel" style="${SECONDARY_CSS}">${esc(t('common.cancel'))}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  els = {
    backdrop: wrap,
    title: wrap.querySelector('#ntTitle'),
    hsk: wrap.querySelector('#ntHsk'),
    source: wrap.querySelector('#ntSource'),
    photoGroup: wrap.querySelector('#ntPhotoGroup'),
    photo: wrap.querySelector('#ntPhoto'),
    camera: wrap.querySelector('#ntCamera'),
    cameraBtn: wrap.querySelector('#ntCameraBtn'),
    camPanel: wrap.querySelector('#ntCamPanel'),
    video: wrap.querySelector('#ntVideo'),
    shot: wrap.querySelector('#ntShot'),
    camClose: wrap.querySelector('#ntCamClose'),
    thumbs: wrap.querySelector('#ntThumbs'),
    result: wrap.querySelector('#ntResult'),
    msg: wrap.querySelector('#ntMsg'),
    process: wrap.querySelector('#ntProcess'),
    upload: wrap.querySelector('#ntUpload'),
    cancel: wrap.querySelector('#ntCancel'),
  };

  els.cancel.onclick = close;
  wrap.addEventListener('click', e => { if (e.target === wrap && !busy) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && wrap.classList.contains('open') && !busy) close();
  });
  els.process.onclick = processPhoto;
  els.upload.onclick = uploadText;
  // Changing any input invalidates a previous result.
  [els.title, els.hsk, els.source].forEach(el => el.addEventListener('input', () => { if (result) clearResult(); }));
  // File picker (several at once) and camera both ADD to the same list, in order.
  els.photo.addEventListener('change', () => { addPhotos([...els.photo.files]); els.photo.value = ''; });
  els.camera.addEventListener('change', () => { addPhotos([...els.camera.files]); els.camera.value = ''; });
  // Paste an image from the clipboard (desktop): Ctrl/Cmd+V anywhere in the modal.
  document.addEventListener('paste', onPaste);
  els.cameraBtn.onclick = openCamera;
  els.shot.onclick = takeShot;
  els.camClose.onclick = stopCamera;
  // Remove a photo, or move it one place earlier / later. Send order = list order.
  els.thumbs.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b || busy) return;
    const i = Number(b.dataset.i);
    const act = b.dataset.act;
    if (act === 'rm') photos.splice(i, 1);
    else {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= photos.length) return;
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }
    clearResult();
    paintThumbs();
    // Keep keyboard focus on the moved file's button (the list was re-rendered).
    if (act !== 'rm') els.thumbs.querySelector(`button[data-act="${act}"][data-i="${act === 'up' ? i - 1 : i + 1}"]`)?.focus();
  });
}

// Ctrl/Cmd+V with an image on the clipboard (a screenshot, "copy image"…). A paste
// with only text is left alone, so typing in the title / source still works.
function onPaste(e) {
  if (!els.backdrop?.classList.contains('open') || busy || result) return;   // no attaching once processed
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addPhotos(files);
}

function addPhotos(files) {
  const imgs = files.filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return;
  // Start reading right now (some browsers invalidate a File once its <input> is
  // cleared); only the insertion is queued, so the attach order is kept.
  const jobs = imgs.map(f => ({
    name: f.name || 'image',
    read: fileToDataUrl(f).catch(e => { console.error('photo unreadable:', e); return null; }),
  }));
  addQueue = addQueue.then(() => addPhotosNow(jobs));
}

async function addPhotosNow(jobs) {
  const room = Math.max(0, MAX_PHOTOS - photos.length);
  let unreadable = 0;
  for (const job of jobs.slice(0, room)) {
    const dataUrl = await job.read;
    if (dataUrl) photos.push({ id: ++photoSeq, name: job.name, dataUrl });
    else unreadable++;
  }
  clearResult();
  paintThumbs();
  if (jobs.length > room) setMsg(t('texts.maxPhotos').replace('{n}', MAX_PHOTOS), 'err');
  else if (unreadable) setMsg(t('texts.photoUnreadable'), 'err');
}

// Attached files, one slim row each (no preview): position (= send order), file
// name, and move up / move down / remove buttons.
function paintThumbs() {
  els.thumbs.style.display = photos.length ? 'flex' : 'none';
  const BTN = 'flex:0 0 auto;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--muted);font-size:.8rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center';
  els.thumbs.innerHTML = photos.map((p, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:3px 6px 3px 10px;background:var(--surf);border:1px solid var(--bdr);border-radius:10px;font-size:.74rem;color:var(--muted)">
      <span style="flex:0 0 auto;color:var(--faint);font-weight:700">${i + 1}</span>
      <span title="${esc(p.name)}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
      ${i > 0 ? `<button type="button" data-act="up" data-i="${i}" aria-label="${esc(t('texts.photoEarlier'))}" style="${BTN}">↑</button>` : ''}
      ${i < photos.length - 1 ? `<button type="button" data-act="down" data-i="${i}" aria-label="${esc(t('texts.photoLater'))}" style="${BTN}">↓</button>` : ''}
      <button type="button" data-act="rm" data-i="${i}" aria-label="${esc(t('texts.photoRemove'))}" style="${BTN}">×</button>
    </div>`).join('');
}

/* ── Camera ──
   Phones: <input capture> opens the native camera app. Desktop browsers ignore
   `capture`, so there we open the webcam with getUserMedia and grab a frame
   (needs HTTPS or localhost). */
let camStream = null;

function stopCamera() {
  camStream?.getTracks().forEach(tr => tr.stop());
  camStream = null;
  if (els.video) els.video.srcObject = null;
  if (els.camPanel) els.camPanel.style.display = 'none';
}

async function openCamera() {
  if (busy) return;
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch || !navigator.mediaDevices?.getUserMedia) { els.camera.click(); return; }
  stopCamera();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    els.video.srcObject = camStream;
    els.camPanel.style.display = 'flex';
    setMsg('');
  } catch (e) {
    console.error('camera failed:', e);
    camStream = null;
    setMsg(t('texts.cameraError'), 'err');
  }
}

function takeShot() {
  const v = els.video;
  if (!camStream || !v.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  canvas.toBlob(blob => {
    if (!blob) return;
    addPhotos([new File([blob], 'camera.jpg', { type: 'image/jpeg' })]);
    // Keep the webcam open so the next page can be shot right away; it closes
    // with "Close camera" (or when the modal closes).
  }, 'image/jpeg', 0.92);
}

function setMsg(text, kind) {
  els.msg.textContent = text || '';
  els.msg.style.color = kind === 'ok' ? 'var(--green)' : kind === 'err' ? '#c04050' : 'var(--faint)';
}

function setBusy(on) {
  busy = on;
  [els.process, els.upload, els.photo, els.camera, els.cameraBtn, els.shot].forEach(el => { el.disabled = on; });
  els.process.style.opacity = els.upload.style.opacity = on ? '.6' : '';
  syncFieldLock();
}

// Title, HSK level and source are locked while working AND once the photo has been
// processed: the review below was made for those values and they are what gets
// uploaded. Adding another photo discards the result and unlocks them again.
function syncFieldLock() {
  const locked = busy || !!result;
  [els.title, els.hsk, els.source].forEach(el => {
    el.disabled = locked;
    el.style.opacity = locked ? '.6' : '';
  });
}

function clearResult() {
  result = null;
  els.result.style.display = 'none';
  els.result.innerHTML = '';
  els.upload.style.display = 'none';
  els.process.style.display = '';
  setMsg('');
  if (els.photoGroup) els.photoGroup.style.display = '';   // the attach controls come back
  paintThumbs();   // bring the photos back (they were hidden while reviewing)
  syncFieldLock();
}

// The modal is built once, so its fixed texts are re-applied every time it opens:
// the language may have changed since (or the modal was built before it was set).
function localizeModal() {
  applyStaticTranslations(els.backdrop);
  els.backdrop.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  // HSK level names ("HSK 7-9" for 7) in case their label depends on the language.
  [...els.hsk.options].forEach(o => { o.textContent = hskLabel(Number(o.value)); });
}

function open() {
  build();
  localizeModal();
  els.title.value = els.source.value = '';
  els.hsk.value = '1';
  stopCamera();
  els.photo.value = els.camera.value = '';
  photos = [];
  paintThumbs();
  clearResult();
  setBusy(false);
  els.backdrop.classList.add('open');
  setTimeout(() => els.title.focus(), 50);
}

function close() {
  stopCamera();
  els.backdrop.classList.remove('open');
}

/* Pinyin for the preview: the same source the reader uses, so what you review is
   what will be shown. A word in the `words` table gives its pinyin (most frequent
   entry for homographs); otherwise each Han character falls back to the
   `characters` table. Words missing from both just show no pinyin. */
let _pyMap = null, _pySrc = null;
function pinyinOf(zh) {
  if (_pySrc !== state.WORDS) {
    _pySrc = state.WORDS;
    _pyMap = new Map();
    for (const w of state.WORDS || []) {
      const prev = _pyMap.get(w.word);
      if (w.word && (!prev || (w.frequency ?? 0) > (prev.frequency ?? 0))) _pyMap.set(w.word, w);
    }
  }
  const hit = _pyMap.get(zh);
  if (hit?.pinyin) return hit.pinyin;
  if (!HAN.test(zh)) return '';
  return [...zh].map(ch => (HAN.test(ch) ? state.CHARACTERS?.find(c => c.char === ch)?.pinyin : '') || '')
    .filter(Boolean).join(' ');
}

// Each word with its pinyin above it, then the translation per paragraph.
function renderResult(r) {
  const lang = state.lang === 'es' ? 'es' : 'en';
  els.result.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;max-height:44dvh;overflow-y:auto;padding:10px;background:var(--bg);border:1px solid var(--bdr);border-radius:12px">
      ${r.paragraphs.map(p => `
        <div style="display:flex;flex-direction:column;gap:6px">
          <div lang="zh" style="display:flex;flex-wrap:wrap;gap:4px 3px;align-items:flex-end">
            ${p.tokens.map(k => HAN.test(k.zh)
              ? `<span style="display:inline-flex;flex-direction:column;align-items:center;line-height:1.2"><span style="font-size:.6rem;color:var(--faint);min-height:.75rem">${esc(pinyinOf(k.zh))}</span><span style="font-size:1rem;color:var(--txt)">${esc(k.zh)}</span></span>`
              : `<span style="font-size:1rem;color:var(--txt);align-self:flex-end">${esc(k.zh)}</span>`).join('')}
          </div>
          <div style="font-size:.72rem;color:var(--muted);line-height:1.5">${esc(p[lang] || p.en)}</div>
        </div>`).join('')}
    </div>`;
  els.result.style.display = '';
  els.thumbs.style.display = 'none';   // the photos are no longer needed: give the review the space
  stopCamera();
  els.photoGroup.style.display = 'none';   // nothing more can be attached once processed
}

// A valid access token for the Edge Function. getSession() returns whatever is
// stored, even if it has expired (typical on a phone after the app sat in the
// background), and the function would answer 401 "Sign in required". So refresh
// it when it is expired or about to be; `force` always refreshes.
async function freshAccessToken(force = false) {
  let { data: { session } } = await supa.auth.getSession();
  if (!session) return null;
  const expiresInMs = (session.expires_at ?? 0) * 1000 - Date.now();
  if (force || expiresInMs < 60_000) {
    const { data, error } = await supa.auth.refreshSession();
    if (error || !data?.session) return null;
    session = data.session;
  }
  return session.access_token;
}

function callFunction(name, token, body) {
  return fetch(`${SUPA_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const callTextImport = (token, images, title) => callFunction('text-import', token, { images, title });

/* ── Leading number in the title ──
   A Chinese title often starts with its number: "12、你好", "3. 我喜欢快", "十二 你好",
   "11.2 购物", "（二）做客". That number is not part of the title: it is left out of what
   is sent to be translated, and it becomes the text's `position` (11.2 -> 11.2). The number must be followed by
   a separator (、 . ， : ) or a space), so titles that merely start with a numeral
   ("一个电话", "3月的雨", "3.5倍") are not touched. */
const CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
function cnToNumber(s) {
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) cur = CN_DIGIT[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  return total + cur;
}
// "11.2" -> 11.2. Only the first two parts count ("11.2.1" -> 11.2) and at most 3
// decimals, which is what `position numeric(6,3)` stores.
function decimalOf(s) {
  const parts = s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).split(/[.．]/);
  const major = parseInt(parts[0], 10);
  return parts.length > 1 ? Number(`${major}.${parts[1].slice(0, 3)}`) : major;
}
const TITLE_NUM_RE = new RegExp(
  '^\\s*[（(【\\[]?\\s*' +
  '(?:([0-9０-９]+(?:[.．][0-9０-９]+)*)|([零〇一二两三四五六七八九十百]+))' +   // 1: digits (also 11.2), 2: Chinese numerals
  '\\s*(?:[、，,：:)）\\]】。．]|\\.(?!\\d)|\\s)\\s*' +           // required separator ("." not before a digit)
  '(\\S.*)$', 'u');

// -> { num: number | null, rest: title without its leading number }
// Two more shapes of a numbered title that the separator rule above misses:
//  - only the number ("11.3"): nothing to translate;
//  - a dotted number glued to the Chinese ("11.3购物"): a "x.y" number right before a
//    Chinese character is a section number, not a decimal.
const NUM_ONLY_RE  = /^\s*[（(【[]?\s*([0-9０-９]+(?:[.．][0-9０-９]+)*)\s*[)）\]】]?\s*$/u;
const NUM_GLUED_RE = /^\s*([0-9０-９]+[.．][0-9０-９]+(?:[.．][0-9０-９]+)*)\s*(\p{Script=Han}.*)$/u;

function parseTitle(raw) {
  const title = String(raw || '').trim();
  let num = null, rest = title;
  let m;
  if ((m = TITLE_NUM_RE.exec(title))) {
    num = m[1] ? decimalOf(m[1]) : cnToNumber(m[2]);
    rest = m[3].trim();
  } else if ((m = NUM_ONLY_RE.exec(title))) {
    num = decimalOf(m[1]);
    rest = '';
  } else if ((m = NUM_GLUED_RE.exec(title))) {
    num = decimalOf(m[1]);
    rest = m[2].trim();
  }
  // `position` is numeric(6,3): up to 999.999.
  if (num == null || !Number.isFinite(num) || num < 0 || num >= 1000) return { num: null, rest: title };
  return { num, rest };
}

async function processPhoto() {
  if (busy) return;
  const title = els.title.value.trim();
  if (!title) { setMsg(t('texts.needTitle'), 'err'); els.title.focus(); return; }
  if (!photos.length) { setMsg(t('texts.needPhoto'), 'err'); return; }
  setBusy(true);
  setMsg(t('texts.processing'));
  try {
    await window._supabaseReady;
    let token = await freshAccessToken();
    if (!token) throw new Error(t('texts.needLogin'));
    // Pages in the order they were attached; the server reads them as ONE continuous text.
    const images = photos.map(p => p.dataUrl);
    // The title sent to be translated has its leading number removed ("12、你好" -> "你好").
    const parsed = parseTitle(title);
    const titleToTranslate = parsed.num != null ? parsed.rest : title;   // '' when the title is only a number
    let resp = await callTextImport(token, images, titleToTranslate);
    if (resp.status === 401) {   // token rejected: refresh once and retry
      token = await freshAccessToken(true);
      if (!token) throw new Error(t('texts.needLogin'));
      resp = await callTextImport(token, images, titleToTranslate);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    result = data;
    renderResult(data);
    els.process.style.display = 'none';
    els.upload.style.display = '';
    setMsg(t('texts.processed'), 'ok');
  } catch (e) {
    console.error('text import failed:', e);
    setMsg(`${t('texts.processError')} ${e.message || ''}`.trim(), 'err');
  } finally {
    setBusy(false);
  }
}

// Starts the text's audio in the background: the `text-audio` function answers
// right away (202) and keeps working on the server, so the app doesn't have to stay
// open or wait. texts.audio_url stays empty until the audio is ready. Calling it again
// is the retry (clips already made are skipped). Rejects if it could not be started.
export async function startTextAudio(id) {
  await window._supabaseReady;
  let token = await freshAccessToken();
  if (!token) throw new Error(t('texts.needLogin'));
  let resp = await callFunction('text-audio', token, { id });
  if (resp.status === 401) {
    token = await freshAccessToken(true);
    if (!token) throw new Error(t('texts.needLogin'));
    resp = await callFunction('text-audio', token, { id });
  }
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error([data.error, data.detail].filter(Boolean).join(': ') || `HTTP ${resp.status}`);
  }
}

async function uploadText() {
  if (busy || !result) return;
  setBusy(true);
  let id;
  try {
    await window._supabaseReady;
    setMsg(t('texts.uploading'));
    const hsk = Number(els.hsk.value);
    // `position` (numeric(6,3)) orders passages inside a level and is not unique. If the
    // title starts with a number ("12、你好", "11.2 购物") that number is the position;
    // otherwise the text goes after the highest position of its level.
    let position = parseTitle(els.title.value).num;
    if (position == null) {
      const { data: last, error: posErr } = await supa
        .from('texts').select('position').eq('hsk', hsk)
        .order('position', { ascending: false }).limit(1);
      if (posErr) throw posErr;
      // whole number after the highest one (after 11.2 comes 12, not 12.2)
      position = Math.floor(Number(last?.[0]?.position ?? 0)) + 1;
    }
    // Safety net: if the Chinese title had a number, the translated titles must not start
    // with one either, even if the model copied it ("11.2 Compras" -> "Compras").
    const hadNumber = parseTitle(els.title.value).num != null;
    const cleanTitle = s => {
      const out = hadNumber ? String(s || '').replace(/^\s*[（(\[]?\s*\d+(?:[.．]\d+)*\s*[)）\].、:：-]?\s*/u, '').trim() : String(s || '').trim();
      return out || null;
    };
    const { data: row, error } = await supa.from('texts').insert({
      title: els.title.value.trim(),
      title_en: cleanTitle(result.title_en),
      title_es: cleanTitle(result.title_es),
      hsk,
      position,
      text: result.text,
      text_en: result.text_en || null,
      text_es: result.text_es || null,
      source: els.source.value.trim() || null,
    }).select('id').single();
    if (error) throw error;
    id = row.id;
  } catch (e) {
    console.error('text insert failed:', e);
    setMsg(`${t('texts.uploadError')} ${e.message || ''}`.trim(), 'err');
    setBusy(false);
    return;
  }

  // The text exists now. Start its audio on the server and leave: no waiting.
  result = null;
  onCreated(id);   // the list shows it right away, and the app starts watching for its audio
  try {
    await startTextAudio(id);
    els.upload.style.display = 'none';
    setMsg(t('texts.uploaded'), 'ok');
    setBusy(false);
    setTimeout(close, 1200);
  } catch (e) {
    // Not fatal: the text is saved. An admin can start the audio from the open text.
    console.error('text audio start failed:', e);
    els.upload.style.display = 'none';
    setMsg(`${t('texts.audioError')} ${e.message || ''}`.trim(), 'err');
    setBusy(false);
  }
}

// Wires the floating "+" button. `onDone` runs after a successful insert
// (the caller reloads the list).
export function initTextCreate(btn, onDone) {
  onCreated = onDone || (() => {});
  btn.onclick = open;
}
