-- ── Spaced repetition (SRS) ──────────────────────────────────────────────────
-- Adds per-item scheduling to the existing progress tables. Additive and
-- backward-compatible: existing rows get NULLs, which the client treats as
-- "due now" so they re-enter rotation and get scheduled on the next review.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL). Safe to re-run.

alter table public.progress
  add column if not exists due_at        timestamptz,
  add column if not exists interval_days integer,
  add column if not exists ease          real,
  add column if not exists reps          integer,
  add column if not exists last_reviewed timestamptz;

alter table public.word_progress
  add column if not exists due_at        timestamptz,
  add column if not exists interval_days integer,
  add column if not exists ease          real,
  add column if not exists reps          integer,
  add column if not exists last_reviewed timestamptz;

-- Speeds up "what's due for this user" lookups (optional but cheap).
create index if not exists progress_due_idx
  on public.progress (user_id, due_at);
create index if not exists word_progress_due_idx
  on public.word_progress (user_id, due_at);
