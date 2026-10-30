// Graphile Worker crontab — standard cron syntax (UTC by default, which
// matches the existing shouldRunNow() behavior in src/lib/cron/jobs.ts).
//
// Format: "minute hour dayOfMonth month dayOfWeek taskName"
//
// Edit this file to change a schedule. No Heroku Scheduler involvement.
//
// Not on cron:
//   - `fresh-metrics-sync` was removed 2026-04-24 — it bypassed the decay
//     gate and was burning ~4,800 SC calls/day. Velocity snapshots are now
//     captured by targeted `capture-velocity-snapshot` jobs scheduled per
//     post at publish time (T+15m, 30m, 1h, 2h, 4h).
//   - `cross-post-scan` (the v2 LLM recommender) was removed 2026-05-02.
//     Cross-post queue v3 is a live percentile-within-format view served
//     by `selectCrossPostCandidates` on every page load; no scheduled job.
//
// DST note: graphile-worker runs cron in UTC. `daily-scorecard-email` at
// 13:00 UTC = 9am EDT during DST (Mar–Nov), 8am EST in winter. If a strict
// 9am-Eastern-wall-clock cadence becomes important, switch to 14:00 UTC and
// accept 10am EDT in summer instead.
//
// `my-work-digest` at 12:00 UTC on weekdays = 8am EDT, before the US team
// starts and mid-afternoon for the editors further east.
//
// `performance-decay` runs on its own named queue so hourly runs never
// overlap. On 2026-10-21 four deploys in an hour kept interrupting it; the
// retried 21:00 run and the 22:00 run then ran side by side, held both
// worker slots for 30+ min (re-fetching the same items, ~10x the usual SC
// calls), and starved `worker-heartbeat` until the health monitor paged.
// Serialized, at most one slot is ever decay's.
//
// `worker-heartbeat` runs at priority -10 (graphile fetches `priority asc,
// run_at asc`). On 2026-10-27 the :05 account-content-sync fan-out (~50
// jobs) queued ahead of every heartbeat while diarize held the other slot;
// the row went 8+ min stale and /api/health/worker paged on a busy, healthy
// worker. Now the heartbeat takes the next free slot. Keep it the lowest
// number here (crontab.test.ts enforces it).
export const CRONTAB = `
* * * * * worker-heartbeat ?priority=-10
* * * * * webhook-dispatch-sweep ?jobKey=webhook-dispatch-sweep&jobKeyMode=preserve_run_at
0 * * * * performance-decay ?queue=performance-decay
15 * * * * threshold-monitor-sweep
30 * * * * notion-sync
20 * * * * enrichment-sweep
35 * * * * extract-poster-sweep
40 * * * * hook-dispatch-sweep
55 * * * * vision-extract-sweep
5 * * * * account-content-sync-sweep
*/10 * * * * schedule-reconcile-sweep
50 * * * * schedule-nodate-sweep
25 * * * * publish-live-sweep
*/30 * * * * sync-link-metrics
0 15 * * * evergreen-scan
*/20 * * * * youtube-download-sweep
0 17 * * 1 account-refresh-sweep
0 13 * * * daily-scorecard-email
0 12 * * 1-5 my-work-digest
*/15 * * * * sc-credits-watch
*/15 * * * * descript-credits-watch
45 * * * * yt-archive-watch
5 12 * * * newsletter-history-sync
10 */2 * * * newsletter-slots-sweep
20 * * * * newsletter-send-sweep
30 15 * * * clip-idea-drought-watch
0 14 * * * format-editor-rules
`.trim();
