/* ── PASSWORD RESET ──
   Shown after the user follows a recovery link (see app.js: type=recovery /
   the PASSWORD_RECOVERY auth event). At that point Supabase has already put the
   user in a temporary recovery session, so we just collect a new password and
   save it with updateUser(). */

import { supa } from './config.js';
import { t } from './i18n.js';

export function showPasswordReset(opts = {}) {
  if (document.querySelector('.pwreset-backdrop')) return;   // one at a time
  const expired = !!opts.expired;

  const backdrop = document.createElement('div');
  backdrop.className = 'pwreset-backdrop';
  backdrop.innerHTML = expired
    ? `
    <div class="pwreset-sheet" role="dialog" aria-modal="true" aria-label="${t('pwreset.expiredTitle')}">
      <div class="pwreset-title">${t('pwreset.expiredTitle')}</div>
      <div class="pwreset-error" style="color:var(--muted)">${t('pwreset.expired')}</div>
      <button class="pwreset-save pwreset-ok" type="button">${t('pwreset.ok')}</button>
    </div>`
    : `
    <div class="pwreset-sheet" role="dialog" aria-modal="true" aria-label="${t('pwreset.title')}">
      <div class="pwreset-title">${t('pwreset.title')}</div>
      <div style="position:relative;width:100%">
        <input class="pwreset-input" type="password" placeholder="${t('pwreset.new')}" autocomplete="new-password" style="padding-right:40px"/>
        <button class="pwreset-eye" type="button" tabindex="-1" aria-label="Show password" style="position:absolute;top:50%;right:6px;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;background:none;border:none;color:var(--muted);cursor:pointer">
          <svg class="pwreset-eye-open" width="17" height="17" viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0"/><path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8m8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7"/></svg>
          <svg class="pwreset-eye-off" width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="m10.79 12.912-1.614-1.615a3.5 3.5 0 0 1-4.474-4.474l-2.06-2.06C.938 6.278 0 8 0 8s3 5.5 8 5.5a7 7 0 0 0 2.79-.588M5.21 3.088A7 7 0 0 1 8 2.5c5 0 8 5.5 8 5.5s-.939 1.721-2.641 3.238l-2.062-2.062a3.5 3.5 0 0 0-4.474-4.474z"/><path d="M5.525 7.646a2.5 2.5 0 0 0 2.829 2.829zm4.95.708-2.829-2.83a2.5 2.5 0 0 1 2.829 2.829zm3.171 6-12-12 .708-.708 12 12z"/></svg>
        </button>
      </div>
      <div class="pwreset-error"></div>
      <button class="pwreset-save" type="button">${t('pwreset.save')}</button>
    </div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));

  const close = () => { backdrop.classList.remove('show'); setTimeout(() => backdrop.remove(), 250); };

  if (expired) {
    backdrop.querySelector('.pwreset-ok').addEventListener('click', close);
    return;
  }

  const input = backdrop.querySelector('.pwreset-input');
  const errEl = backdrop.querySelector('.pwreset-error');
  const btn   = backdrop.querySelector('.pwreset-save');
  input.focus();

  const eyeBtn = backdrop.querySelector('.pwreset-eye');
  eyeBtn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    backdrop.querySelector('.pwreset-eye-open').style.display = show ? '' : 'none';
    backdrop.querySelector('.pwreset-eye-off').style.display  = show ? 'none' : '';
    eyeBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });

  const submit = async () => {
    const pw = input.value;
    errEl.style.color = '#c04050';
    if (pw.length < 6) { errEl.textContent = t('pwreset.short'); return; }
    btn.disabled = true;
    const { error } = await supa.auth.updateUser({ password: pw });
    if (error) { btn.disabled = false; errEl.textContent = error.message; return; }
    errEl.style.color = 'var(--green)';
    errEl.textContent = t('pwreset.done');
    setTimeout(close, 1400);
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}
