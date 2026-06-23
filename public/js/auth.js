import { supa, SUPA_URL, STRIPE_PRICE } from './config.js';
import { state } from './state.js';

export async function loadUserPlan() {
  if (!state.supaUser) { state.userPlan = 'free'; return; }
  const { data } = await supa.from('profiles').select('plan').eq('id', state.supaUser.id).single();
  state.userPlan = data?.plan ?? 'free';
}

// Sends the browser-derived hints to the profile-sync Edge Function, which adds
// the server-resolved country and upserts the row. Country is resolved on the
// server so the client never calls a geo service or leaks the IP from here.
export async function syncUserProfile() {
  if (!state.supaUser) return;

  let timezone = null;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* ignore */ }
  const hints = {
    locale:    navigator.language ?? null,
    languages: (navigator.languages || []).join(',') || null,
    timezone,
    platform:  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
  };

  try {
    const { data: { session } } = await supa.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    await fetch(`${SUPA_URL}/functions/v1/profile_sync`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(hints),
    });
  } catch (e) {
    console.warn('Profile sync failed:', e);
  }
}

// Permanently deletes the signed-in user's account and data. The actual deletion
// runs server-side in the `delete-account` Edge Function (service-role), which
// removes the auth user plus their rows; we just pass the session token.
export async function deleteAccount() {
  const { data: { session } } = await supa.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const resp = await fetch(`${SUPA_URL}/functions/v1/delete-account`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(detail || `Delete failed (${resp.status})`);
  }
  await supa.auth.signOut();
}

export async function startCheckout() {
  if (!state.supaUser) { alert('Please sign in first to purchase.'); return; }
  try {
    const { data: { session: authSession } } = await supa.auth.getSession();
    const resp = await fetch(`${SUPA_URL}/functions/v1/bright-worker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authSession.access_token}`
      },
      body: JSON.stringify({
        price_id:    STRIPE_PRICE,
        user_id:     state.supaUser.id,
        success_url: window.location.origin + window.location.pathname + '?upgraded=1',
        cancel_url:  window.location.origin + window.location.pathname
      })
    });
    const json = await resp.json();
    if (json.url) {
      window.location.assign(json.url);
    } else {
      alert('Error: ' + (json.error || 'no url returned'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}
