---
description: Run ONE health lap of the Hub & Spoke ops loop — check Sentry, Heroku, job queue, archiver; fix only known-safe things; report loudly on the rest.
argument-hint: "[optional focus, e.g. 'queue' or 'sentry']"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

## ⏸ Pause guard (check FIRST, before anything)

If `~/.claude/LOOPS_PAUSED` exists (`test -f ~/.claude/LOOPS_PAUSED`), Pat has paused all
loops. Say "loops are paused — not running this lap" and STOP. No work, no wakeups.

## 🚗 Vehicle guard — the runner owns cadence

This loop's vehicle is the fresh-context runner (`~/.claude/loop-runner.sh`, launched by
`/go`). **NEVER pace laps with ScheduleWakeup:** if this lap arrived via `/loop` or a
ScheduleWakeup firing, run NOTHING, call ScheduleWakeup with `stop: true`, and end. A
`claude -p "/lap"` runner lap just ends normally; the runner sleeps and re-fires.

## 🐢 Throttle guard

If `~/.claude/LOOPS_THROTTLE` exists, Pat is low on credits — do the two cheapest checks
only (worker heartbeat + queue tripwire), log one line, end. The runner already stretches
the sleep; schedule nothing.

## 💸 Token discipline

This is a MONITORING lap, not a build lap. It should normally cost almost nothing:
- Run the checklist with as few Bash calls as possible (batch the queries).
- **Green lap = one log line and DONE.** No narrative, no exploring, no "while I'm here."
- Diagnose only what a check flags, and only deep enough to classify it (see Fix policy).
- Never spin: an investigation that hasn't classified the problem after ~10 tool calls
  gets written up as UNKNOWN with everything gathered, and the lap ends.

## 🚫 What this loop must NEVER do

- **Never `git commit` or `git push`** — pushes auto-deploy to Heroku. This loop observes
  production; it does not ship code. (House rule: never commit/push without explicit
  permission — a cron lap has none.)
- Never scale dynos beyond the documented baseline (web=1, worker=1), change Heroku config
  vars, run migrations, or DELETE data outside the exact runbook actions listed below.
- Never touch other machines' loops (Pulse, Slope, yt-archive internals beyond the listed
  kickstart).

## The checklist (one lap)

Optional focus: **$ARGUMENTS** (if set, run only the matching section + the heartbeat).

Sync docs first (read-only): `git pull --rebase --autostash 2>&1 | tail -1` — runbooks in
`docs/automation.md` may have been updated. A pull conflict = log it, continue on stale.

Run these, batching aggressively (2–4 Bash calls total on a green lap):

1. **Worker heartbeat** — `curl -s https://hubandspoke.starterstory.com/api/health/worker`.
   `ok:true` + small ageSeconds = healthy. 503/stale → check dynos (item 3).
2. **Sentry** — unresolved issues, org `pat-walls`, project `hubandspoke`
   (`$SENTRY_ACCESS_TOKEN` is in `~/.zshenv`, available to laps):
   `curl -s -H "Authorization: Bearer $SENTRY_ACCESS_TOKEN" "https://sentry.io/api/0/projects/pat-walls/hubandspoke/issues/?query=is:unresolved&statsPeriod=24h&limit=10"`
   Compare against the previous lap's log entry — only NEW issues or count spikes matter.
3. **Heroku dynos + memory** — `heroku ps --app hubandspoke` (both `up`?) and
   `heroku logs --app hubandspoke --num 150 | grep -cE "R14|R15|H12|H13"` (0 = clean).
4. **Queue fatness** — one psql over `heroku pg:psql --app hubandspoke`:
   - total jobs (`graphile_worker._private_jobs`) — healthy is < ~500;
   - **corruption tripwire**: `count(*)` vs `count(DISTINCT identifier)` on
     `graphile_worker._private_tasks` — ANY divergence is CRITICAL (see the 2026-08-09
     incident in `docs/automation.md`: it means the pkey/unique constraints are gone and
     every enqueue amplifies);
   - any single identifier with > 1,000 pending rows;
   - oldest due unlocked job older than 1h.
5. **yt-archive (this Mac)** — `launchctl list | grep yt-archive` (2nd column = last exit;
   0/2 fine, 6 = Heroku creds, 8 = host memory — decoder in `docs/automation.md`). If
   nonzero, `tail -15 ~/Library/Logs/hubandspoke-yt-archive.log` to classify.

## Fix policy — narrow allowlist, everything else reports

**Allowed autonomous fixes** (each is an established runbook action, safe + reversible):
- Worker dyno `crashed` → `heroku ps:restart worker --app hubandspoke` (once per lap; if
  it's crashed again next lap, that's CRITICAL — report, don't restart-loop).
- yt-archive last exit 8 with the log showing the eviction race → one
  `launchctl kickstart -k gui/501/com.hubandspoke.yt-archive`, verify the log advances.
- Sentry issues that are exact duplicates of an already-logged, already-reported finding →
  note the recurrence, no new report.

**Everything else — queue tripwire firing, R14/R15 streaks, unknown Sentry spikes, growing
queue, creds failures (exit 6 needs Pat's Heroku key) — is REPORT, not fix:**
1. Append a full entry to the health log (below) with the evidence gathered.
2. Raise it loudly: `curl` a Sentry store event (same DSN as the yt-archive wrapper — see
   `home-machine/yt-archive/wrapper.sh` SENTRY_KEY/SENTRY_STORE_URL) with
   `fingerprint: ["hubandspoke-health-loop"]` and a message naming the finding — that rides
   Pat's existing Sentry alerting. One event per NEW finding, not per lap.

## Log — the lap's only artifact

Append ONE entry to `~/.claude/hubandspoke-health.log` (local file, never committed):
```
2026-08-09 14:30  OK  sentry=0new heroku=up/clean queue=18(tasks 55=55) yt=exit0
```
or on findings, the same line with `ATTN`/`CRIT` + a short indented block of evidence and
what was done (fixed per allowlist / reported via Sentry). The previous entries ARE the
memory between laps — read the last ~5 lines at lap start instead of re-deriving state.
