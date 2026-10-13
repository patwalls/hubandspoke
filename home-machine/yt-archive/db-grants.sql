-- db-grants.sql — the ONLY privileges the home-Mac archiver's DB login has.
--
-- The archiver connects as the Heroku Postgres credential `yt_archive`
-- (security lap S-068, 2026-10-12), not the app's owner credential, so
-- code running on the home Mac can't read users/sessions/tokens or rewrite
-- arbitrary data. Column-level grants mirror exactly what
-- scripts/archive-yt-local.ts queries. **If you change a query in that
-- script, update this file and re-apply it** — otherwise the next hourly run
-- fails with "permission denied for table/column …" (Sentry + yt-archive-watch
-- will flag it).
--
-- Idempotent. Apply as the owner credential:
--   heroku pg:psql --app hubandspoke -f home-machine/yt-archive/db-grants.sql
-- One-time credential setup (already done for prod):
--   heroku pg:credentials:create DATABASE --name yt_archive --app hubandspoke

GRANT USAGE ON SCHEMA public TO yt_archive;

-- --brands=auto resolution
GRANT SELECT (id, slug, disabled) ON brands TO yt_archive;
GRANT SELECT (brand_id, platform, is_active, deleted_at) ON accounts TO yt_archive;

-- candidate query (+ --ids path)
GRANT SELECT (id, youtube_id, youtube_url, title, brand, status, media_s3_key,
              published_date, deleted_at, youtube_download_attempts, post_type)
    ON production_items TO yt_archive;

-- success + failure UPDATEs
GRANT UPDATE (media_s3_bucket, media_s3_key, media_s3_uploaded_at, media_size_bytes,
              media_content_type, youtube_download_source, youtube_download_error,
              youtube_download_attempts)
    ON production_items TO yt_archive;

-- "already transcribed?" check before enqueueing Whisper
GRANT SELECT (production_item_id, full_text) ON transcripts TO yt_archive;

-- the only way it can touch the job queue (drizzle/0114): transcribe-whisper
-- for one item. No graphile_worker schema access at all.
GRANT EXECUTE ON FUNCTION public.yt_archive_enqueue_whisper(uuid) TO yt_archive;
