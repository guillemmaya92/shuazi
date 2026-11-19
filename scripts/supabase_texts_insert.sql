-- ── Admins can import texts from the app ────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Who is an admin is stored in profiles.is_admin. To make yourself admin, after
-- running this script (replace the email):
--   update public.profiles set is_admin = true where email = 'tu@email.com';
-- (or tick the column in Table Editor → profiles).

-- 1. The flag.
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- 2. Users can edit their own profile row (policy "own profile update"), so the
--    flag MUST be protected, or anyone could promote themselves from the browser.
--    Only the SQL editor / dashboard / service role may change it; requests made
--    with a user token (role "authenticated" or "anon") can't.
create or replace function public.protect_is_admin() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.is_admin := false;
    elsif new.is_admin is distinct from old.is_admin then
      new.is_admin := old.is_admin;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_is_admin on public.profiles;
create trigger protect_is_admin
  before insert or update on public.profiles
  for each row execute function public.protect_is_admin();

-- 3. Helper used by the policies (security definer: reads the flag regardless of RLS).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- 4. Policies on texts.
drop policy if exists "texts admin insert" on public.texts;
create policy "texts admin insert"
  on public.texts for insert
  to authenticated
  with check (public.is_admin());

-- Lets an admin also see unpublished rows.
drop policy if exists "texts admin read" on public.texts;
create policy "texts admin read"
  on public.texts for select
  to authenticated
  using (public.is_admin());

-- Admins can delete a text (button inside an open text): the row is removed from the
-- table for good. text_progress rows that reference it go with it (on delete cascade).
drop policy if exists "texts admin delete" on public.texts;
create policy "texts admin delete"
  on public.texts for delete
  to authenticated
  using (public.is_admin());

-- Admins can also edit texts (e.g. change `position` or `hsk` from the dashboard/app).
drop policy if exists "texts admin update" on public.texts;
create policy "texts admin update"
  on public.texts for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Deleting a text also removes its audio manifest (tts/texts/<id>.json) from Storage.
-- Only that file: the sentence clips (tts/v1/…) are shared between texts and stay.
drop policy if exists "tts admin delete manifest" on storage.objects;
create policy "tts admin delete manifest"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'tts' and name like 'texts/%' and public.is_admin());
