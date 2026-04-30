# Working through hubandspoke fixes

This file is the playbook for me (Claude) when Pat says `/fixthings`. The flow is: read the
backlog from the **production `fixes` table**, work each one, mark it `done`, repeat. Don't
ask before starting — start.

## Production is the source of truth

**Fixes are filed from Pat's phone against production.** Local DB is irrelevant for the
backlog — an empty local list just means local is stale, not that there's no work.

Two ways to read the prod backlog:

**Option A — query prod directly (preferred for a quick scan):**
```bash
heroku pg:psql --app hubandspoke -c \
  "SELECT id, status, category, LEFT(note, 80) AS note, filed_by_email, created_at \
   FROM fixes WHERE status IN ('open','in_progress') ORDER BY created_at;"
```

**Option B — `/pulldb`, then work locally (preferred for actually working fixes since the
per-fix workflow needs to verify against real data):**
1. Run `/pulldb` (drops + restores local DB from prod).
2. List the backlog locally:
   ```bash
   psql -d hubandspoke_development -c \
     "SELECT id, status, category, LEFT(note, 80), filed_by_email, created_at \
      FROM fixes WHERE status IN ('open','in_progress') ORDER BY created_at;"
   ```

Default to **Option B** because the per-fix workflow below needs real data, and `heroku
pg:psql` per query is too slow for that loop.

## The job

1. Pull prod (Option B above).
2. Work fixes in filed-order (oldest first) unless one is obviously blocking the others.
3. For each fix: mark `in_progress` (on prod), do the work locally, commit, mark `done` (on
   prod) with a short `resolution_note` describing what shipped.

## Per-fix workflow

For every fix (status updates write to **prod** so the live `/fixes` page reflects progress):

1. **Mark in_progress** on prod so the `/fixes` page shows it's being worked:
   ```bash
   heroku pg:psql --app hubandspoke -c \
     "UPDATE fixes SET status='in_progress', updated_at=now() WHERE id='<uuid>';"
   ```
2. **Pull context.** Every fix carries `url` (page Pat was on) + `page_html` (rendered DOM
   snapshot) + optional `photo_keys` (S3 attachments). To inspect:
   ```bash
   psql -d hubandspoke_development -c \
     "SELECT url, photo_keys, LEFT(page_html, 4000) FROM fixes WHERE id='<uuid>';" | less
   ```
   To view photos: `/api/fixes/<uuid>/photo/<idx>` redirects to a presigned S3 URL — open
   that in a browser, or sign one yourself with the AWS CLI if you have credentials.
3. **Decide where to look.** See "Where to look by category" below.
4. **Do the work.** Read the relevant files, make the change.
5. **Verify locally.** Run the relevant smoke for the surface you touched:
   - UI changes: load the page in the browser (`PORT=3000 npm run dev`), confirm the change.
   - Background tasks: `npm run dev:all` and trigger via `/api/cron/tick?name=<task>`.
   - DB queries: re-run the fix's URL or the relevant report query.
   - Type-check: `npm run build` (Heroku release does this; catch errors before push).
6. **Commit per fix.** One commit, prefix with `Fix <short-id>:` (first 8 chars of the
   uuid is fine), body explaining what changed. Stage only files you touched.
7. **Mark done** on prod with a 1-line resolution note:
   ```bash
   heroku pg:psql --app hubandspoke -c \
     "UPDATE fixes SET status='done', resolution_note='<short, what shipped>', updated_at=now() \
      WHERE id='<uuid>';"
   ```
8. If something can't be done in one shot (needs schema change, external API, etc.), leave it
   `in_progress`, write a blocker into `resolution_note` like "blocked: needs Notion API
   permission for X", and move to the next.

## When to mark `needs_decision`

Use this when a fix is too big or ambiguous to ship in one pass and genuinely needs Pat's
judgment before any code lands. Typical signals:

- The fix asks for a brainstorm or "let's discuss" — pick a direction first.
- The work would take a day or more and depends on a call (paid API vs scrape, library
  choice, schema redesign, etc.).
- You'd otherwise get stuck in a loop on the same fix every `/fixthings` run.

There are **two flavors** depending on size:

### A. Direction-only (small)

A clear-but-ambiguous call: which library? scrape vs paid API? this column or that one?
Total work after the call is a few hours.

1. Mark the fix `needs_decision` on prod.
2. Write the options + your recommendation directly into `resolution_note` — keep it tight
   (3–6 bullets). Lead with the recommendation; list the tradeoffs after.
3. Stop /fixthings for that fix. Move to the next.

### B. Feature-sized (big)

The "fix" is actually a feature: multi-day work, schema redesign, new external service,
new UI flow, multiple routes / services. Don't try to brainstorm this in `resolution_note`
— write a real plan instead.

1. Write a plan file at `.claude/fix-plans/fix-<short-id>.md` (in the repo, tracked in
   git). Same shape as a Claude Code plan-mode plan: **Context** (what the fix asked for
   + why it's feature-sized), **Approach** (recommended path), **Files to modify**,
   **Verification**, **Tradeoffs / alternatives considered**.
2. Set `resolution_note` to a short summary Pat can read on his phone, ending with:
   `Plan: .claude/fix-plans/fix-<short-id>.md` so he knows where to dig in.
3. Mark the fix `needs_decision` on prod.
4. Commit **only the plan file** with `Fix <short-id> plan: <one-line summary>`. Don't
   push — let Pat pull when he wants to review.
5. **Stop /fixthings entirely** for this run. Don't move on to the next fix — shipping
   more on top of an unread feature plan creates rebase pain if Pat redirects you.

When Pat redirects (flips back to `open` with a clarifying note, or replaces with a new
fix), execute against the plan file as your spec. Delete the plan file in the same commit
that ships the feature, so plans don't accumulate.

### Either flavor

`/fixthings` queries `WHERE status IN ('open','in_progress')`, so `needs_decision` fixes
are skipped on the next run by design. They sit on the **Needs decision** tab on `/fixes`
until Pat reads them and either:
- flips back to `open` (with a clarifying note in the existing `resolution_note`, or in
  the plan file for feature-sized fixes) — green light to ship the recommended path
- replaces with a new fix carrying a different direction
- marks `wont_fix` if the brainstorm killed the idea

## When to mark `wont_fix`

- Duplicate of another fix already done
- Out of scope (asks for something the system explicitly doesn't do)
- Premised on a misunderstanding (e.g., field already exists and is filled, just not visible
  for this row)

Always set `resolution_note` explaining why so Pat doesn't re-file.

## Where to look by category

| `category` | Likely files |
|---|---|
| `ui` | `src/app/(dashboard)/**`, `src/components/**`. Mobile rules: defer to existing patterns; check `[brand]/page.tsx` for layout container. |
| `data_wrong` | `src/lib/services/notion-sync.ts` (Notion → DB), `src/lib/db/queries.ts` (report aggregations), the relevant cross-post / metrics service in `src/lib/services/`, `src/jobs/tasks/**` if the wrong data was set by a worker job. |
| `automation` | `src/jobs/tasks/**` (the worker task itself), `src/jobs/crontab.ts` (schedules), `docs/automation.md` (docs are required by CLAUDE.md when touching jobs). |
| `idea` | Bigger asks — usually warrants `needs_decision` first unless the path is obvious. |
| `other` / blank | Read the note carefully. Check `url` + `page_html` for context. |

## Useful one-liners

```bash
# Counts by status (prod)
heroku pg:psql --app hubandspoke -c \
  "SELECT status, COUNT(*) FROM fixes GROUP BY status ORDER BY status;"

# All fixes filed in the last 7 days (prod)
heroku pg:psql --app hubandspoke -c \
  "SELECT id, status, category, LEFT(note, 80) FROM fixes \
   WHERE created_at > now() - interval '7 days' ORDER BY created_at;"

# Inspect a specific fix's context (local, after /pulldb)
psql -d hubandspoke_development -c \
  "SELECT id, status, category, url, photo_keys, note, resolution_note FROM fixes \
   WHERE id='<uuid>';"
```

## Standing rules

- **Never `git add -A`.** Stage only files you touched (`git add path/to/file ...`).
- **Never auto-push.** Commit locally; push to GitHub `main` only when Pat asks. Heroku
  auto-deploys from GitHub on push.
- **Status changes go to prod, not local.** Use `heroku pg:psql --app hubandspoke -c "..."`
  for `UPDATE` so the live `/fixes` page reflects progress in real time.
- **One commit per fix** so each is reviewable and revert-able.
- **Don't add columns to `fixes`** without asking — Pat designed it minimal on purpose.
- **Doc rule (from CLAUDE.md):** if you touched `src/jobs/**` or `src/lib/services/**`,
  `docs/automation.md` must be updated in the same commit. If you added/removed/renamed a
  user-facing route or major column, `docs/features.md` must be updated.
