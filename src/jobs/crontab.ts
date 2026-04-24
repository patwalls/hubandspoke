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
export const CRONTAB = `
0 * * * * performance-decay
15 * * * * threshold-monitor-sweep
30 * * * * notion-sync
20 * * * * enrichment-sweep
40 * * * * hook-dispatch-sweep
*/30 * * * * account-content-sync-sweep
0 15 * * * evergreen-scan
*/20 * * * * youtube-download-sweep
0 17 * * 1 account-refresh-sweep
`.trim();
