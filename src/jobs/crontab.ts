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
export const CRONTAB = `
* * * * * worker-heartbeat
0 * * * * performance-decay
15 * * * * threshold-monitor-sweep
30 * * * * notion-sync
20 * * * * enrichment-sweep
35 * * * * extract-poster-sweep
40 * * * * hook-dispatch-sweep
55 * * * * vision-extract-sweep
5 * * * * account-content-sync-sweep
*/30 * * * * klaviyo-sync-sweep
*/30 * * * * sync-link-metrics
0 15 * * * evergreen-scan
*/20 * * * * youtube-download-sweep
0 17 * * 1 account-refresh-sweep
0 13 * * * daily-scorecard-email
*/15 * * * * sc-credits-watch
*/15 * * * * descript-credits-watch
45 * * * * yt-archive-watch
`.trim();
