// Graphile Worker crontab — standard cron syntax (UTC by default, which
// matches the existing shouldRunNow() behavior in src/lib/cron/jobs.ts).
//
// Format: "minute hour dayOfMonth month dayOfWeek taskName"
//
// Edit this file to change a schedule. No Heroku Scheduler involvement.
//
// Not on cron: `cross-post-scan` is invoked manually via the "Populate queue"
// button in /[brand]/queue (POST /api/cross-post-scan). `fresh-metrics-sync`
// stays on cron so when the operator clicks the button the view_snapshots
// cohort is already populated; without it the velocity gate has nothing to
// compare against.
export const CRONTAB = `
0 * * * * performance-decay
*/15 * * * * fresh-metrics-sync
15 * * * * threshold-monitor-sweep
30 * * * * notion-sync
20 * * * * enrichment-sweep
40 * * * * hook-dispatch-sweep
0 13 * * * account-content-sync-sweep
0 15 * * * evergreen-scan
*/20 * * * * youtube-download-sweep
0 17 * * 1 account-refresh-sweep
`.trim();
