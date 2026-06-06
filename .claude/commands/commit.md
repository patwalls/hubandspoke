---
description: Commit ONLY this session's files and push to main (auto-deploys to Heroku)
argument-hint: "[optional commit message]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git rev-list:*), Bash(git fetch:*), Bash(git add:*), Bash(git commit:*), Bash(git show:*), Bash(git rebase:*), Bash(git pull:*), Bash(git push:*)
---

## Context (auto-injected)

- Current branch: !`git branch --show-current`
- Working tree (⚠️ INCLUDES OTHER CLAUDE SESSIONS' / WORKTREES' FILES — do NOT blindly stage these): !`git status --short`
- Recent commits: !`git log --oneline -8`
- Local vs origin/main (left = ahead, right = behind): !`git fetch origin main --quiet 2>/dev/null; git rev-list --left-right --count HEAD...origin/main 2>/dev/null`

## Your task

Commit ONLY the files **this session** worked on, then push to `main`. Pushing `main`
**auto-deploys to production via the GitHub→Heroku Actions workflow** (`Deploy to
Heroku`) — and Heroku's release phase runs `npm run db:migrate` first, so a push here
ships code AND migrations to prod. Treat it accordingly.

### ⚠️ Parallel-session safety — read this first

Pat runs multiple Claude Code sessions / git worktrees on this repo at once. The
`git status` above will show files from OTHER sessions mixed in with yours. Stage
**only** the files this session created or edited — the running tracked list from this
conversation.

- **NEVER** `git add -A`, `git add .`, or `git commit -a`. Stage explicit paths only.
- If a changed file appears that you don't recognize / didn't touch, leave it alone.
- Lockfile churn (`package-lock.json` reordered by a stray `npm install`) is NOT yours
  unless you actually changed dependencies — don't stage it.
- If you're unsure whether a changed file is yours, **STOP and ask Pat** before staging.
  Committing someone else's half-finished work can fail the build and break the deploy.

### Steps

1. **Identify your files.** From this conversation, build the exact list of files YOU
   created or modified. Do not derive it from `git status` alone (it's polluted with
   other sessions' work).

2. **Stage only those:** `git add <path1> <path2> …` — explicit paths, never a wildcard.

3. **Honor the docs-in-the-same-commit rule** (see CLAUDE.md → "Documentation"). Check
   your staged paths:
   - touched `src/jobs/**` or `src/lib/services/**` → stage `docs/automation.md` too;
   - added/removed/renamed a user-facing route, API endpoint, or major column
     (`src/app/(dashboard)/**`, `src/app/api/**`, `src/lib/db/schema.ts`) → stage
     `docs/features.md` too;
   - new task/cron/schema pattern → check `docs/conventions.md`.
   If a change genuinely needs no doc update (rename, internal refactor, typo,
   dependency bump, CSS-only fix), say so in the commit body.
   - **Schema change?** The migration SQL under `drizzle/` (from `npm run db:generate`)
     MUST be staged with the `schema.ts` change — they deploy together or the release
     phase fails.

4. **Write the message.**
   - If `$ARGUMENTS` is non-empty, use it as the commit subject/message.
   - Otherwise compose a concise subject (≤72 chars) + a short body explaining *what*
     and *why*, based on the staged diff only.
   - End with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

5. **Commit, then verify what landed.** Run `git show --stat HEAD` and confirm ONLY your
   intended paths appear. Git's rename detection can silently pull a second path into the
   commit (`old/path => new/path | 0`). If a path you didn't intend appears, `git reset
   --soft HEAD~1`, restage correctly, and recommit BEFORE pushing.

6. **Sanity-check the build before shipping** (a push to `main` deploys immediately). If
   you changed TypeScript/TSX, at minimum it should typecheck — a broken build fails the
   deploy. If unsure, run `npm run build` (or the relevant `npm run test`) first.

7. **Sync with main before pushing** (ahead/behind count is in the context above).
   - If `origin/main` is AHEAD of you (right number > 0): `git pull --rebase origin main`.
     Resolve conflicts ONLY in files you edited.
   - If a rebase conflict touches a file you did NOT edit (another session/worktree
     colliding with its own upstream work): `git rebase --abort` and ask Pat.
   - Never `git pull` without `--rebase` — keep history linear, no merge commits.

8. **Push:** `git push origin main`.
   - Never `git push --force` / `-f`. If rejected (non-fast-forward), re-run
     `git fetch origin main` + `git pull --rebase origin main`, re-verify, push again.
   - Never `git push heroku main` — the GitHub→Heroku Actions integration owns the
     deploy; pushing the Heroku remote directly desyncs the two.

9. **Confirm & report.** State the commit SHA + subject, the files included, and that the
   push to `main` kicked off the Heroku auto-deploy. Optionally confirm with
   `gh run list --repo patwalls/hubandspoke --limit 1` that the deploy workflow started.

### Notes
- This commits on the **current branch** and pushes to `origin main`. If the current
  branch (shown above) is NOT `main`, flag that to Pat and confirm the intended target
  before proceeding — the auto-deploy only fires on `main`. (You can ship just one commit
  off a feature branch with `git push origin <sha>:main` when that's the intent.)
- Do not touch files outside your tracked list. Do not run unrelated tools.
