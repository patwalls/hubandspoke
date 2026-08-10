---
description: Run ONE lap of the Hub & Spoke ops loop — check Sentry, Heroku, request times, job queue, archiver; SELF-HEAL within the guardrails; escalate what it can't fix.
argument-hint: "[optional focus, e.g. 'queue' or 'sentry']"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

## ⏸ Pause guard (FIRST)

If `~/.claude/LOOPS_PAUSED` exists — say "loops are paused", STOP. No work, no wakeups.

## 🚗 Vehicle guard

The vehicle is the fresh-context runner (`~/.claude/loop-runner.sh`, launched by `/go`,
resurrected by `home-machine/ops-loop-recovery.sh`). **Never pace laps with
ScheduleWakeup** — if this lap arrived via `/loop` or a ScheduleWakeup firing, run nothing,
ScheduleWakeup `stop: true`, end. A runner lap just ends; the runner sleeps and re-fires.

## 🐢 Throttle guard

If `~/.claude/LOOPS_THROTTLE` exists: run ONLY the heartbeat + queue tripwire, one log
line, end. No healing beyond a worker restart, no pushes.

## 💸 Spend discipline (every lap)

Pat pays per lap — keep green laps NEAR-FREE:
- Read the last ~5 lines of `~/.claude/hubandspoke-health.log` first; that IS the memory.
- Then one `npx tsx scripts/ops-escalate.ts status` — what's already raised on GitHub, what
  is building toward it, and what a human has muted. A fresh-context lap has no other way
  to know Pat already ruled on something; skipping this is how you re-raise a closed issue.
- Batch the whole green-path checklist into 2–3 Bash calls. **All green → one log line,
  END THE LAP.** No narrative, no exploration, no "while I'm here".
- Only a flagged check earns more tool calls. An investigation that hasn't classified its
  problem after ~12 tool calls gets logged UNKNOWN with evidence + a Sentry event, lap ends.
- Never spin: same approach failing twice = stop, escalate. Third retries are banned.

## The checklist

Optional focus: **$ARGUMENTS** (if set: that section + heartbeat only).

`git pull --rebase --autostash` first (docs/runbooks may have moved). Then, batched:

1. **Liveness (2 curls)** — `https://hubandspoke.starterstory.com/api/health/worker`
   (`ok:true`, small ageSeconds) and `/login` (200, and note the response time).
2. **Sentry** (org `pat-walls`, project `hubandspoke`; token in `~/.zshenv`):
   unresolved issues, `statsPeriod=24h`. Only NEW issues (vs health log) or event-count
   spikes matter.
3. **Heroku (2 calls)** — `heroku ps` (web+worker `up`) + `heroku releases -n 1` (a
   `release failed` = broken deploy pipeline, CRIT). Then one `heroku logs --num 300`
   pass reused for BOTH memory errors (`R14|R15|H12|H13`) and **request times**: parse
   router `service=NNNms`, ignoring media/upload routes (`/api/files`, `/api/uploads`,
   `/api/media-proxy`, `/api/image-proxy`, `/_next/`).
4. **Database sweep — ONE `heroku pg:psql` call** returning one row of named columns:
   - queue: total jobs · **tripwire** `count(*)` vs `count(DISTINCT identifier)` on
     `_private_tasks` · max rows per identifier · oldest due unlocked age ·
     `attempts>=max_attempts` corpses · locks older than 4h;
   - **cron liveness**: any `graphile_worker._private_known_crontabs` row whose
     `last_execution` is older than ~2.5× its period (catches silently-dead crons —
     notion-sync, performance-decay, the credit watches — without hitting their APIs);
   - **stuck Descript renders** (this week's class): items with
     `descript_publish_job_id IS NOT NULL AND descript_published_at IS NULL AND
     descript_publish_error IS NULL AND updated_at < now()-interval '2 hours'`;
   - **event-storm guard** (the "clip ready ×100" class): any single item with > 25
     `content_events` rows in the last 24h;
   - **sync failures**: `sync_logs` rows with `status='error'` in the last 24h (count +
     newest sync_type);
   - **exhausted YouTube downloads**: items at `youtube_download_attempts >= 3` still
     missing media, published in the last 7 days;
   - db size vs the 64 GB plan and connection count vs 200.
5. **This Mac (one bash block)** — yt-archive last exit (`launchctl list`; decoder in
   `docs/automation.md`; on nonzero read the log tail) · disk free on `/System/Volumes/Data`
   (yt-archive needs tmp space) · swap free (persistent exhaustion = the ollama-contention
   class; the archiver will be skipping) · the ops-loop recovery agent still loaded
   (`launchctl list | grep ops-loop-recovery`).

### Thresholds (Pat-tunable — edit here)

| signal | WARN | CRIT |
|---|---|---|
| request time (non-media) | any > 3s, or ~p95 > 2s | any H12/H13, or 3+ > 10s |
| /login response | > 2s | non-200 |
| memory | any R14 | any R15 |
| deploy | — | latest release `failed` |
| queue total | > 500 | > 5,000 or growing across 2 laps |
| tasks tripwire | — | ANY divergence (2026-08-09 incident) |
| one identifier pending | > 1,000 | > 10,000 |
| oldest due job / stale locks | > 1h / any 4h+ lock | > 6h |
| cron last-fired | > 2.5× its period | notion-sync or performance-decay dead > 6h |
| stuck Descript renders | any ≥ 2h | ≥ 5 items, or any ≥ 12h |
| event storm (one item/24h) | > 25 events | > 100 events |
| sync_logs errors/24h | > 3 | > 10 or all-failing for one sync_type |
| exhausted YT downloads (7d) | ≥ 3 items | ≥ 8 items |
| DB size / connections | > 32 GB / > 120 | > 55 GB / > 180 |
| Sentry issue events/24h | new issue | > 50 on one issue |
| heartbeat | ageSeconds > threshold | 503 / unreachable |
| Mac disk free / swap free | < 25 GB / < 1 GB sustained | < 10 GB |
| recovery agent | — | not loaded in launchctl |

## 📣 What a human hears about — the hands-off contract

**Pat does not want to hear about a problem you found and then fixed.** A successful
self-heal is a log line and nothing else: no GitHub issue, no Sentry event, no summary
addressed to him. The loop exists so that routine breakage stops being his problem.

He hears from you in exactly one situation: **you are proposing something you did not do.**
That reaches him as a GitHub issue — or, when you can write the fix but aren't allowed to
merge it, a **draft PR with the code already in it**. GitHub, not the health log, because
he is not the only person working on this app and the rest of the team can read, comment
on, and close a GitHub artifact.

Everything outbound goes through `scripts/ops-escalate.ts`. Never run `gh issue create`
or `gh pr create` by hand — the script owns fingerprint dedup, the streak gate, the rate
limiter, and the mute rules, and hand-rolled calls bypass all four.

| situation | what happens |
|---|---|
| fixed it yourself (rung 1 or 2) | health-log line only — **silent** |
| something's off but transient / unconfirmed | `report --severity attn` — tracked, never escalates |
| can't fix it, no code would (creds, spend, vendor, account config) | `report --severity warn\|crit` → issue after 3 laps (2 for CRIT) |
| could fix it in code, but it's outside rung 2's limits | write the fix on a branch, push the branch, `report … --branch <name>` → **draft PR** |
| CRIT that needs a human tonight | escalate as above **and** one Sentry event |

Sentry is now reserved for CRIT only. A `warn` finding must never fire a Sentry event —
the 22-unresolved-issue backlog as of 2026-08-09 is what happens when everything pages.

## 🔧 Self-healing ladder — try, verify, escalate

Work DOWN this ladder; every action gets logged with evidence. Only a CRIT that survives
the lap also gets a Sentry event (`fingerprint: ["hubandspoke-health-loop"]`, same DSN as
`home-machine/yt-archive/wrapper.sh`) so Pat's alerting fires.

**Rung 1 — ops actions (no code):**
- worker/web dyno crashed → `heroku ps:restart <dyno>` once; verify it comes back `up`.
- yt-archive exit 8 + eviction-race log signature → one `launchctl kickstart`, verify.
- Stale graphile locks held by dead workers → clear per the runbook.
- **Stuck Descript render** with a still-live publish job → re-enqueue one keyed poll via
  `graphile_worker.add_job` (jobKey `descript-publish:<id>`, queue `media-heavy` — the
  exact recovery used 2026-08-09). Dead publish job ("No job found") → stamp
  `descript_publish_error` so the UI shows Retry; never re-render automatically (that
  spends Descript credits).
- Dead cron (last_execution stale) → `GET /api/cron/tick?name=<task>` with
  `Authorization: Bearer $CRON_SECRET` (from `heroku config:get CRON_SECRET`) fires one
  catch-up run; if it's dead again next lap, that's CRIT.
- Recovery agent unloaded → `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.hubandspoke.ops-loop-recovery.plist`.
- Any documented runbook in `docs/automation.md` whose trigger signature matches exactly —
  including the queue-corruption runbook (pause worker → purge amplified rows → restore
  `_private_tasks` constraints → resume) — executed with the evidence quoted in the log.

**Rung 2 — code fixes (the "within reason" push authority):**

**Deploy-regression protocol (check EVERY lap, first among rung-2 work):** any
Sentry issue whose `firstSeen` is AFTER the latest release timestamp
(`heroku releases -n 1`) is presumed a shipped regression. For client-side
errors on page routes this is CRITICAL — a user is seeing "Application
error". Response, in order of preference:
1. **`git revert` the offending commit and push** — identify it from the
   release diff; revert beats forward-fixing under pressure and is always
   within the push policy (a revert of a just-shipped commit can't make prod
   older than it was this morning).
2. Forward-fix only when the cause is pinpointed AND the fix is smaller than
   the revert (e.g. a one-line hoist). Reproduce first when a repro is
   cheap: minified TDZ/reference errors un-minify by loading the same route
   against `npm run dev` locally (real symbol names; see 2026-08-10 —
   "Cannot access 'nV'" became "Cannot access 'INLINE_DRAFTING_POST_TYPES'").
3. Either way: Sentry event with what shipped, what broke, what was done.
Note the SSR fail-opens (detail-ssr / queue-ssr tags): those Sentry events
mean users are silently on the slow fallback path — treat as ATTN, not CRIT.
Allowed when ALL hold:
- The root cause is demonstrated (a Sentry stack trace, a reproduced error — not a hunch).
- The fix is small: ≤ ~60 changed lines, ≤ 3 files, no schema/migrations, no new
  dependencies, nothing touching auth, payments, credentials, or deploy infrastructure.
- `npx tsc --noEmit` passes and `npm run test:unit` is no worse than before.
- The CLAUDE.md doc rules are honored (jobs/services changes stage `docs/automation.md`).
- Commit message states the production evidence and the verification run.
**Limits: ONE push per lap, ever.** If the same error signature is back on the lap after a
push, do NOT try again — Sentry CRIT with both attempts' evidence, hands off to Pat.

**Rung 2.5 — propose the fix you're not allowed to make.** When a finding IS fixable in
code but fails any rung-2 condition (needs a migration, > ~60 lines, touches auth/payments/
credentials/deploy, needs a new dependency, or the root cause is clear but the *right* call
is a judgment one) — write it anyway, on a branch, and hand it over as a draft PR:

```bash
git checkout -b ops/<short-slug>
# …write the fix, run `npx tsc --noEmit` and `npm run test:unit`…
git commit -am "proposal: <what and why, with the production evidence>"
git push -u origin ops/<short-slug>
npx tsx scripts/ops-escalate.ts report \
  --fingerprint "<stable-key>" --severity warn \
  --title "<what's broken>" --body-file <evidence.md> --branch ops/<short-slug>
```

Draft, never ready-for-review — a human opens it. **Never push the branch to `main`** and
never merge it yourself; pushing `main` auto-deploys. Tests must pass before the push, same
as rung 2. If you can't get the fix to compile or the tests green, drop the branch and file
a plain issue instead — a broken proposal is worse than a described one.

**Rung 3 — escalate:** anything no code can fix (credentials, spend, vendor outages,
account misconfiguration, ambiguous root cause, repeated failures):

```bash
npx tsx scripts/ops-escalate.ts report \
  --fingerprint "sync-error:linkedin:company-page-url" \
  --severity warn --title "…" --body-file <evidence.md>
```

The **fingerprint is the contract** — a stable key describing the condition, not the
moment (`sync-error:linkedin:company-page-url`, not `sync-error-2026-08-09`). Same
condition next lap must produce the same string, or dedup fails and Pat gets spammed.
Reuse the exact fingerprint you saw in `status`.

Nothing else is needed: the script decides whether this is quiet enough to sit on, updates
an existing issue silently, or opens a new one. Escalating IS a successful lap outcome —
self-healing includes knowing what not to touch.

## Never, regardless of ladder

Scale dynos beyond baseline (web=1, worker=1) · change Heroku config vars · run
migrations · force-push · touch other machines' loops (Pulse/Slope) beyond the yt-archive
kickstart · push twice in one lap · push when tests fail · push a proposal branch to
`main` or mark a draft PR ready · open GitHub issues/PRs by hand instead of through
`ops-escalate.ts` · reopen or re-raise anything a human closed.

## Log — one entry per lap, `~/.claude/hubandspoke-health.log`

```
2026-08-09 14:30  OK    sentry=0new heroku=up/clean req(max 1.8s p95~0.9s) queue=18(55=55) yt=exit0
2026-08-09 15:30  HEAL  worker crashed -> restarted, verified up. rest green
2026-08-09 16:30  CRIT  tripwire 61!=55 -> ran queue runbook (evidence...) -> 55=55; sentry event sent
2026-08-09 17:30  WARN  sync-error:linkedin:company-page-url -> escalate report (2/3 laps, not yet raised)
2026-08-09 19:30  WARN  sync-error:linkedin:company-page-url -> issue #12 opened (3 laps)
```
Findings get a short indented evidence block. The log is local — never committed; it is
the loop's own memory, not a channel anyone reads. Anything a human needs to act on
belongs on GitHub via `ops-escalate.ts` — if it only exists in this file, it did not
happen as far as the team is concerned.
