---
description: Work through the hubandspoke fixes backlog (fixes table) per FIXES.md rules
---

# /fixthings — burn down the fixes backlog

Read `FIXES.md` at the repo root in full — it has the workflow, the queries, and the standing
rules. Then start working through the open fixes.

## Quick start

**Production is the source of truth — fixes are filed against prod from Pat's phone.** An empty
local backlog just means local is stale, not that there's no work.

1. List the prod backlog:
   ```bash
   heroku pg:psql --app hubandspoke -c \
     "SELECT id, status, category, LEFT(note, 80) AS note, filed_by_email, created_at \
      FROM fixes WHERE status IN ('open','in_progress') ORDER BY created_at;"
   ```
2. Default to running `/pulldb` first so the per-fix workflow can verify against real data
   (and so you can read `page_html` / pull S3 photos referenced by `photo_keys` for context).
3. Work fixes oldest-first. Per-fix loop is in `FIXES.md`:
   - mark `in_progress` (on prod) → do the work locally → verify → commit → mark `done` (on
     prod) with a 1-line `resolution_note`.

## Don'ts (also in FIXES.md, repeated here so you can't miss them)

- **Don't `git add -A`.** Stage only the files you touched (`git add path/to/file ...`).
- **Don't auto-push.** Commit locally; only push to GitHub `main` when Pat asks.
- **Don't ask before starting.** That's what this command is for.
- **Don't mark done unless it's actually shipped.** Use `wont_fix` (with reason), leave
  `in_progress` (with a blocker note in `resolution_note`), or flip to `needs_decision` (for
  big or ambiguous asks — see FIXES.md) when appropriate.
- **Don't ship a feature inline.** If a fix is actually a feature (multi-day, schema
  redesign, new external service, new UI flow), don't try to ship it as a single fix.
  Write a plan file at `.claude/fix-plans/fix-<short-id>.md`, set `resolution_note` to a
  short summary + plan-file pointer, mark `needs_decision`, commit just the plan, and
  **stop /fixthings entirely for this run**. See FIXES.md "Feature-sized (big)" for the
  full shape. Recognising feature-sized work early is the single biggest thing that keeps
  /fixthings from spiraling.
- **Don't ship a `needs_decision` fix.** The query above already skips them; if you somehow
  see one in the backlog, write the brainstorm (or plan, for feature-sized) and stop, don't code.

## When the backlog is empty

Run the count **against prod** to confirm:
```bash
heroku pg:psql --app hubandspoke -c \
  "SELECT status, COUNT(*) FROM fixes WHERE status IN ('open','in_progress') GROUP BY status;"
```
If the result is empty, report "Backlog clear" and stop. Don't go looking for new work.
