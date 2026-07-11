-- Reviews submitted from the app's Settings › Review modal.
-- Run this in the Supabase SQL editor (or via `supabase db push`).

create table if not exists public.reviews (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  email      text,
  rating     int  not null check (rating between 1 and 5),
  comment    text,
  lang       text,
  created_at timestamptz not null default now()
);

alter table public.reviews enable row level security;

-- Anyone (signed-in or anonymous) may submit a review. There is intentionally no
-- SELECT policy, so reviews are write-only from the client and can only be read
-- with the service role (Supabase dashboard / server).
drop policy if exists "anyone can insert reviews" on public.reviews;
create policy "anyone can insert reviews"
  on public.reviews
  for insert
  to anon, authenticated
  with check (rating between 1 and 5);
