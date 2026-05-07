---
description: Bulk-archive YouTube videos to prod S3 + production_items so they can be repurposed
---

# /youtube-upload — bulk archive YouTube videos into production

Download published YouTube items from a residential IP (Heroku's IP gets
bot-checked by YouTube), upload the MP4s to prod S3, and stamp
`production_items.media_s3_key` so the rest of the pipeline can use them.
Successful uploads auto-enqueue Whisper transcription.

The script is `scripts/archive-yt-local.ts`. This skill wraps it with a
preflight + a friendlier prompt for teammates who don't remember every flag.

## Step 1 — Ask what to upload

Use the `AskUserQuestion` tool to collect three things in **one** message
(three questions in a single tool call):

1. **Brands** — which brands to pull. Comma-separated. Common values:
   `starter-story`, `matg`. (Required.)
2. **Since** — only items with `published_date >= this`. Default to
   the date 14 days before today (compute it; don't hardcode). Format
   `YYYY-MM-DD`. (Required.)
3. **Limit** — max candidates to process. Default `50`. Bigger batches
   work but each video takes ~30–90s, so 200 means a 1-3h run.

If the user already knows specific item IDs they want to retry, they can
say so — in that case skip brands/since and use `--ids=uuid1,uuid2`.

## Step 2 — Preflight

Run these checks in **parallel** (single message, multiple Bash calls).
If any fails, stop and report the specific fix.

1. **yt-dlp binary present.** `ls node_modules/.yt-dlp-bin/yt-dlp`.
   If missing → `node scripts/install-yt-dlp.mjs`.
2. **Heroku CLI authed.** `heroku apps:info --app hubandspoke | head -3`.
   If 401/403 → tell the user to run `heroku login`.
3. **Required env vars present in `.env.local`.** Verify these keys exist
   (don't print values):
   ```bash
   grep -cE "^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION|HUBANDSPOKE_S3_BUCKET)=" .env.local
   ```
   Expect `4`. If less, tell the user which are missing.
4. **Chrome reminder.** The script reads cookies from Chrome by default
   to defeat YouTube's "Sign in to confirm you're not a bot" gate.
   Tell the user: "Make sure Chrome is signed in to a YouTube account
   before we start — otherwise aged videos and trending content will
   bot-block."

Only proceed once all four are green.

## Step 3 — Run the archive

Source `.env.local` for AWS + S3 creds, fetch `PROD_DB_URL` from Heroku,
then run the script. Run in the **foreground** so the user sees progress
line-by-line (`✓` / `✗` with sizes and timings).

```bash
set -a && source .env.local && set +a && \
PROD_DB_URL=$(heroku config:get DATABASE_URL --app hubandspoke) \
npx tsx scripts/archive-yt-local.ts \
  --brands=<BRANDS> --since=<SINCE> --limit=<LIMIT>
```

Or, if the user gave specific IDs:

```bash
set -a && source .env.local && set +a && \
PROD_DB_URL=$(heroku config:get DATABASE_URL --app hubandspoke) \
npx tsx scripts/archive-yt-local.ts --ids=<UUID1>,<UUID2>
```

Use a generous `timeout` (e.g. `3600000` for 1h) since each video can
take 30–90s and limits up to 200 are normal.

## Step 4 — Report

Read the tail of the output and summarize back to the user:

- Total succeeded vs attempted, total GB, elapsed time.
- For each failure: item ID, title prefix, and the error reason
  (truncated). Group identical errors together.
- If failures mention "Sign in to confirm you're not a bot" → Chrome
  cookies aren't reaching yt-dlp. Suggest signing in to YouTube in
  Chrome and re-running.
- If failures mention "Video unavailable" / "Private video" → those
  items are dead on YouTube; safe to ignore. The script already
  auto-skips items with 3+ prior failures.

## Notes for the operator

- **Idempotent.** The script's candidate query is gated on
  `media_s3_key IS NULL`, so already-archived items are skipped.
  Safe to re-run after any failure.
- **Force-retry a specific item.** Use `--ids=<uuid>` — this bypasses
  the `youtube_download_attempts < 3` skip filter.
- **Output format is fixed.** Always H.264 video + AAC LC audio + MP4
  faststart (Twitter-compatible). Don't tweak `--max-height` past 1080
  unless the user explicitly asks — Twitter caps at 1920×1200.
- **Auto-chain.** On every successful upload the script enqueues a
  `transcribe-whisper` job on the prod graphile_worker queue, so the
  transcript will land within minutes.
- **Connection robustness.** The script has its own pg pool with
  keepalives + retry-on-conn-flap built in (long S3 uploads otherwise
  trip Heroku's idle reaper). Don't worry about transient pg errors in
  the log — they self-heal.
