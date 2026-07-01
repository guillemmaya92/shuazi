-- =============================================================
-- Per-user translator chat history. Each row is one conversation
-- (a list of translations) shown as a single Recents / Pinned item.
-- Run in the Supabase SQL Editor.
-- =============================================================

create table if not exists chats (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  chat_id     text not null,                -- stable client-generated id
  title       text not null default '',     -- preview label (first message's source)
  messages    jsonb not null default '[]',  -- [{ source_text, translation, tokens }]
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per (user, chat); saving a chat again updates it in place.
create unique index if not exists chats_user_chat_uidx
  on chats (user_id, chat_id);

create index if not exists chats_user_updated_idx
  on chats (user_id, updated_at desc);

-- Row Level Security: each user only ever sees/edits their own rows.
alter table chats enable row level security;

create policy "own read"   on chats for select to authenticated using (auth.uid() = user_id);
create policy "own insert" on chats for insert to authenticated with check (auth.uid() = user_id);
create policy "own update" on chats for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own delete" on chats for delete to authenticated using (auth.uid() = user_id);

-- The old per-translation table is superseded by this one. Drop it to reclaim the
-- space (its history isn't migrated — chats start fresh). Comment out to keep it.
drop table if exists translations;
