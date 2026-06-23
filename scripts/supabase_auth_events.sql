-- =============================================================
-- Login audit trail. Run in the Supabase SQL Editor.
-- One append-only row per sign-in: who, when, from where.
-- =============================================================

create table if not exists auth_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  event      text not null default 'sign_in',
  ip         text,
  country    text,    -- 'ES'
  city       text,    -- 'Madrid'
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists auth_events_user_created_idx
  on auth_events (user_id, created_at desc);

alter table auth_events enable row level security;

-- Users may append their own events and read their own history, but NOT update
-- or delete them — keeping the audit trail tamper-proof. (Service role and the
-- dashboard bypass RLS for full audit access.)
create policy "own insert" on auth_events for insert to authenticated with check (auth.uid() = user_id);
create policy "own read"   on auth_events for select to authenticated using (auth.uid() = user_id);
