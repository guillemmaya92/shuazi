/* ── PWA INSTALL ──
   Browser-agnostic "Add to Home Screen" prompt.

   • Android / Desktop (Chrome, Edge, Brave…): uses the `beforeinstallprompt`
     event to drive the native install dialog.
   • iOS / iPadOS (Safari): that event doesn't exist, so we show a small sheet
     explaining the Share → "Add to Home Screen" steps.
   • Already installed (standalone) or unsupported browsers: shows nothing.

   Self-contained: builds its own DOM and is dismissible (remembered for a week).
*/

const DISMISS_KEY = 'pwa-install-dismissed';
const DISMISS_DAYS = 7;

// Dev preview: add ?pwa=test (or ?pwa=ios / ?pwa=android) to the URL to force the
// banner and instruction sheets in any environment — even on localhost or after
// it's been dismissed — purely for visual testing.
const DEBUG = new URLSearchParams(location.search).get('pwa');

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS 13+ reports as desktop Safari but is touch-capable.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isAndroid = () => /android/i.test(navigator.userAgent);

const isInStandaloneCapableIOSBrowser = () =>
  isIOS() && 'standalone' in window.navigator; // Safari (Chrome/Firefox iOS lack it)

function recentlyDismissed() {
  try {
    const ts = +localStorage.getItem(DISMISS_KEY) || 0;
    return Date.now() - ts < DISMISS_DAYS * 864e5;
  } catch { return false; }
}
function rememberDismiss() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
}

export function initPwaInstall() {
  if (isStandalone() && !DEBUG) return;  // already installed — nothing to do

  let deferredPrompt = null;
  let banner = null;

  // ── Banner ──
  function buildBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.className = 'pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install app');
    banner.innerHTML = `
      <div class="pwa-banner-icon" aria-hidden="true">刷字</div>
      <div class="pwa-banner-text">
        <strong>Install Shuazi</strong>
        <span>Add it to your home screen</span>
      </div>
      <button class="pwa-banner-install" type="button">Install</button>
      <button class="pwa-banner-close" type="button" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>`;
    document.body.appendChild(banner);

    banner.querySelector('.pwa-banner-install').addEventListener('click', triggerInstall);
    banner.querySelector('.pwa-banner-close').addEventListener('click', () => {
      rememberDismiss();
      hideBanner();
    });
    return banner;
  }
  function showBanner() {
    if (recentlyDismissed() && !DEBUG) return;
    buildBanner();
    requestAnimationFrame(() => banner.classList.add('show'));
  }
  function hideBanner() {
    if (!banner) return;
    const el = banner;
    banner = null;                         // allow a future showBanner to rebuild
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);    // drop from the DOM after the transition
  }

  // ── Install action ──
  async function triggerInstall() {
    if (DEBUG === 'ios')     { showIOSSheet();     return; }   // preview only
    if (DEBUG === 'android') { showAndroidSheet(); return; }   // preview only
    if (deferredPrompt) {                 // Android / Desktop Chromium
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch { /* ignore */ }
      deferredPrompt = null;
      hideBanner();
      return;
    }
    if (isIOS()) { showIOSSheet(); return; }   // iOS: manual steps
    showAndroidSheet();                         // Android / other: manual steps
  }

  // ── Manual instructions sheet (shared shell) ──
  function buildSheet(bodyHTML) {
    const backdrop = document.createElement('div');
    backdrop.className = 'pwa-sheet-backdrop';
    backdrop.innerHTML = `
      <div class="pwa-sheet" role="dialog" aria-label="Install instructions">
        <div class="pwa-sheet-title">Install Shuazi</div>
        ${bodyHTML}
        <button class="pwa-sheet-ok" type="button">Got it</button>
      </div>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
    const close = () => { backdrop.classList.remove('show'); setTimeout(() => backdrop.remove(), 250); };
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    backdrop.querySelector('.pwa-sheet-ok').addEventListener('click', close);
  }

  // iOS / iPadOS: no install event — explain the Share → Add to Home Screen flow.
  function showIOSSheet() {
    const inSafari = isInStandaloneCapableIOSBrowser();
    buildSheet(inSafari ? `
        <ol class="pwa-sheet-steps">
          <li><span>Tap the Share button</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m8 8 4-4 4 4"/><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/></svg></li>
          <li><span>Choose “Add to Home Screen”</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg></li>
          <li><span>Tap “Add” to finish</span></li>
        </ol>` : `
        <p class="pwa-sheet-note">Open this page in <strong>Safari</strong>, then tap Share → “Add to Home Screen”.</p>`);
  }

  // Android / other browsers: shown only when the native install event never
  // arrives — point the user at the browser menu's install option.
  function showAndroidSheet() {
    buildSheet(`
        <ol class="pwa-sheet-steps">
          <li><span>Open the browser menu</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg></li>
          <li><span>Tap “Install app” / “Add to Home screen”</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg></li>
          <li><span>Confirm to finish</span></li>
        </ol>`);
  }

  // ── Wire platform events ──
  // The install event often fires before this module finishes loading, so the
  // inline script in index.html captures it first. Pick it up if it's waiting.
  if (window._deferredInstallPrompt) {
    deferredPrompt = window._deferredInstallPrompt;
    showBanner();
  }
  // …and react to it if it's relayed a moment later.
  window.addEventListener('pwa-prompt-ready', () => {
    deferredPrompt = window._deferredInstallPrompt;
    showBanner();
  });
  // Direct listener too, in case this module did load before the event.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();                   // stop the mini-infobar
    deferredPrompt = e;
    window._deferredInstallPrompt = e;
    showBanner();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window._deferredInstallPrompt = null;
    hideBanner();
    rememberDismiss();
  });

  if (DEBUG) {
    // Dev preview — force the banner regardless of platform/installability.
    showBanner();
  } else if (isIOS()) {
    // iOS never fires beforeinstallprompt — show the banner proactively.
    showBanner();
  } else if (isAndroid()) {
    // Android: if Chrome never sends the install event (engagement heuristics,
    // a non-Chromium browser, etc.), still surface a manual-steps banner after a
    // short grace period so installing is always discoverable.
    setTimeout(() => { if (!deferredPrompt && !isStandalone()) showBanner(); }, 3500);
  }
}
