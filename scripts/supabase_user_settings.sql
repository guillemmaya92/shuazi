-- =============================================================
-- Per-user app settings: game mode, active filters
-- (HSK levels + status: left / know / review) and theme (dark/light).
-- Run in the Supabase SQL Editor.
-- =============================================================

create table if not exists user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  game       text   not null default 'characters',
  hsk_levels int[]  not null default '{1,2,3,4,5,6}',
  statuses   text[] not null default '{left,know,review}',
  theme      text   not null default 'light',
  updated_at timestamptz not null default now()
);

-- Migration for tables created before the theme column existed:
alter table user_settings add column if not exists theme text not null default 'light';

-- Row Level Security: each user only ever sees/edits their own row.
alter table user_settings enable row level security;

create policy "own read"   on user_settings for select to authenticated using (auth.uid() = user_id);
create policy "own insert" on user_settings for insert to authenticated with check (auth.uid() = user_id);
create policy "own update" on user_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own delete" on user_settings for delete to authenticated using (auth.uid() = user_id);
