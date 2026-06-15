import { supa, SUPA_URL, STRIPE_PRICE } from './config.js';
import { state } from './state.js';

export async function loadUserPlan() {
  if (!state.supaUser) { state.userPlan = 'free'; return; }
  const { data } = await supa.from('profiles').select('plan').eq('id', state.supaUser.id).single();
  state.userPlan = data?.plan ?? 'free';
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
