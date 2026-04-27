// Graphile Worker crontab — standard cron syntax (UTC by default, which
// matches the existing shouldRunNow() behavior in src/lib/cron/jobs.ts).
//
// Format: "minute hour dayOfMonth month dayOfWeek taskName"
//
// Edit this file to change a schedule. No Heroku Scheduler involvement.
//
// Not on cron:
//   - `cross-post-scan` is invoked manually via "Populate queue" on
//     /[brand]/queue (POST /api/cross-post-scan).
//   - `fresh-metrics-sync` was removed 2026-04-24 — it bypassed the decay
//     gate and was burning ~4,800 SC calls/day. Velocity snapshots are now
//     captured by targeted `capture-velocity-snapshot` jobs scheduled per
//     post at publish time (T+15m, 30m, 1h, 2h, 4h).
//
// DST note: graphile-worker runs cron in UTC. `daily-scorecard-email` at
// 13:00 UTC = 9am EDT during DST (Mar–Nov), 8am EST in winter. If a strict
// 9am-Eastern-wall-clock cadence becomes important, switch to 14:00 UTC and
// accept 10am EDT in summer instead.
export const CRONTAB = `
0 * * * * performance-decay
15 * * * * threshold-monitor-sweep
30 * * * * notion-sync
20 * * * * enrichment-sweep
40 * * * * hook-dispatch-sweep
5 * * * * account-content-sync-sweep
0 15 * * * evergreen-scan
*/20 * * * * youtube-download-sweep
0 17 * * 1 account-refresh-sweep
0 13 * * * daily-scorecard-email
`.trim();
