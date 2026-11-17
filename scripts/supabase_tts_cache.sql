-- Text-to-speech audio storage (public bucket `tts`).
--
--   v1/<sha256(voice|rate|text)>.mp3   one clip per spoken sentence, uploaded by
--                                      scripts/build_text_audio.py.
--   texts/<id>.json                    per-text manifest (sentence -> clip), built
--                                      by scripts/build_text_audio.py; its public
--                                      URL is stored in texts.audio_url.
--
-- Public URLs:  <SUPABASE_URL>/storage/v1/object/public/tts/<path>
--
-- Public bucket = anyone can READ a file if they know its path (it's speech of
-- public text). There are no insert/update/delete policies, so only the service
-- role (the build script) can write.
--
-- Run once in the Supabase SQL editor.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tts', 'tts', true, 1048576, array['audio/mpeg', 'application/json'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
