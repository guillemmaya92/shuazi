-- Run this in the Supabase SQL Editor before running migrate_words.py

CREATE TABLE IF NOT EXISTS words (
  word      TEXT PRIMARY KEY,
  pinyin    TEXT NOT NULL,
  meaning   TEXT NOT NULL,
  grp       SMALLINT NOT NULL,
  char_ids  INTEGER[]
);

-- GIN index for fast "words containing character X" lookups
CREATE INDEX IF NOT EXISTS words_char_ids_gin ON words USING GIN (char_ids);

-- Allow anonymous read (same as the rest of the app)
ALTER TABLE words ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON words
  FOR SELECT
  TO anon
  USING (true);
