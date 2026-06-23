-- =============================================================
-- Extra per-user info captured on sign-in. Run in the SQL Editor.
-- (Assumes a `profiles` table keyed by id = auth.users.id already exists.)
-- =============================================================

alter table profiles add column if not exists email      text;
alter table profiles add column if not exists full_name  text;
alter table profiles add column if not exists avatar_url text;
alter table profiles add column if not exists country    text;   -- e.g. 'ES'
alter table profiles add column if not exists locale     text;   -- e.g. 'es-ES'
alter table profiles add column if not exists languages  text;   -- e.g. 'es-ES,en-US'
alter table profiles add column if not exists timezone   text;   -- e.g. 'Europe/Madrid'
alter table profiles add column if not exists platform   text;   -- 'mobile' | 'desktop'
alter table profiles add column if not exists last_login timestamptz;

-- Row Level Security: each user can read & write only their own profile row.
alter table profiles enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'own profile read') then
    create policy "own profile read"   on profiles for select to authenticated using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'own profile insert') then
    create policy "own profile insert" on profiles for insert to authenticated with check (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'own profile update') then
    create policy "own profile update" on profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
  end if;
end $$;
