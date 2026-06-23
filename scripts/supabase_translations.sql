-- =============================================================
-- Per-user translation history. Run in the Supabase SQL Editor.
-- =============================================================

create table if not exists translations (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  source_text text not null,
  translation text not null,
  tokens      jsonb,
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- If the table already existed, add the pin flag.
alter table translations add column if not exists pinned boolean not null default false;

-- One stored row per (user, source phrase); re-translating updates it.
create unique index if not exists translations_user_source_uidx
  on translations (user_id, source_text);

create index if not exists translations_user_created_idx
  on translations (user_id, created_at desc);

-- Row Level Security: each user only ever sees/edits their own rows.
alter table translations enable row level security;

create policy "own read"   on translations for select to authenticated using (auth.uid() = user_id);
create policy "own insert" on translations for insert to authenticated with check (auth.uid() = user_id);
create policy "own update" on translations for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own delete" on translations for delete to authenticated using (auth.uid() = user_id);
