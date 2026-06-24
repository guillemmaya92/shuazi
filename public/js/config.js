export const SUPA_URL    = 'https://coysmojauucqgdhhxyrz.supabase.co';
export const SUPA_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNveXNtb2phdXVjcWdkaGh4eXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODAxOTMsImV4cCI6MjA5Njk1NjE5M30.JO6U0TyW5gcnmJMJAvvzSh_ZiMdCKCEtRSz_N8h8adM';
export const STRIPE_PRICE = 'price_1TlomiBbC7zMbLYpULYnfvr1';
export const FREE_HSK    = new Set([1, 2]);
export const STORE_KEY   = 'shuazi-v1';

// Lazy client: created on first property access, after supabase.js has loaded async.
// All consumers (auth.js, ui.js, progress.js) only call supa inside async functions
// that run after `await window._supabaseReady` in app.js, so the SDK is always ready.
let _client = null;
function _get() {
  if (!_client) _client = window.supabase.createClient(SUPA_URL, SUPA_KEY);
  return _client;
}
export const supa = new Proxy({}, {
  get(_, k) { const v = _get()[k]; return typeof v === 'function' ? v.bind(_get()) : v; }
});
