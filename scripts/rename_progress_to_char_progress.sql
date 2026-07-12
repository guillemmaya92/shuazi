-- ── Rename the char progress table: progress → char_progress ─────────────────
-- Pairs the table naming with word_progress. RLS policies, the primary key,
-- foreign keys and grants follow the table automatically on RENAME; only the
-- index name is renamed explicitly (its name doesn't auto-update).
--
-- Run once in the Supabase SQL editor (Dashboard → SQL). Deploy the matching
-- client build (js/progress.js now queries `char_progress`) right after.

alter table public.progress rename to char_progress;

-- Keep the SRS "due" index name consistent with the new table name.
alter index if exists public.progress_due_idx rename to char_progress_due_idx;
