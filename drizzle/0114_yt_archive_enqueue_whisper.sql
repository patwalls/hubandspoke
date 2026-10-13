-- Narrow, SECURITY DEFINER enqueue for the home-Mac YouTube archiver
-- (scripts/archive-yt-local.ts). The archiver connects with a restricted
-- Heroku credential (`yt_archive`, security lap S-068) that must NOT be able to
-- call graphile_worker.add_job directly — that would let whatever runs on the
-- home Mac enqueue any task with any payload. This function can only enqueue
-- `transcribe-whisper` for one production item, deduped by job_key, exactly as
-- the script used to do inline.
--
-- plpgsql (not sql) so the body isn't resolved at CREATE time: a fresh DB runs
-- drizzle migrations before graphile-worker creates its schema.
CREATE OR REPLACE FUNCTION public.yt_archive_enqueue_whisper(p_production_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'transcribe-whisper',
    payload => json_build_object('productionItemId', p_production_item_id),
    job_key => 'transcribe-whisper:' || p_production_item_id::text
  );
END;
$$;
--> statement-breakpoint
-- Functions are executable by PUBLIC by default; the yt_archive credential is
-- granted EXECUTE explicitly (outside migrations — the role only exists in prod).
REVOKE ALL ON FUNCTION public.yt_archive_enqueue_whisper(uuid) FROM PUBLIC;
