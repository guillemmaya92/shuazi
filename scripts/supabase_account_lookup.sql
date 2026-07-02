-- ── Account lookup (for the "forgot password" UX) ────────────────────────────
-- Reports whether an email is registered, whether it has a password, and which
-- auth providers it uses — so the reset screen can tell users "no account" or
-- "use Google". Reads the protected auth schema, so it is SECURITY DEFINER and
-- only the service role (used by the check-account Edge Function) may execute it.
--
-- ⚠️ This intentionally exposes account existence (email enumeration) for UX.
--
-- Run once in the Supabase SQL editor.

create or replace function public.account_lookup(p_email text)
returns table (has_password boolean, providers text[])
language sql
security definer
set search_path = public, auth
as $$
  select
    (u.encrypted_password is not null and u.encrypted_password <> '') as has_password,
    coalesce(array_agg(i.provider order by i.provider) filter (where i.provider is not null), '{}') as providers
  from auth.users u
  left join auth.identities i on i.user_id = u.id
  where lower(u.email) = lower(trim(p_email))
  group by u.id, u.encrypted_password;
$$;

-- Lock it down: only the service role (the Edge Function) may call it.
revoke all on function public.account_lookup(text) from public;
revoke all on function public.account_lookup(text) from anon;
revoke all on function public.account_lookup(text) from authenticated;
