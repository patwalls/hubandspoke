// Graphile Worker crontab — standard cron syntax (UTC by default, which
// matches the existing shouldRunNow() behavior in src/lib/cron/jobs.ts).
//
// Format: "minute hour dayOfMonth month dayOfWeek taskName"
//
// Edit this file to change a schedule. No Heroku Scheduler involvement.
export const CRONTAB = `
0 * * * * performance-decay
15 * * * * threshold-monitor-sweep
30 * * * * notion-sync
20 * * * * enrichment-sweep
40 * * * * hook-extract-sweep
50 * * * * hook-fallback-sweep
55 * * * * vision-extract-sweep
0 13 * * * matg-sync
0 15 * * * evergreen-scan
0 16 * * * cross-post-scan
*/20 * * * * youtube-download-sweep
0 17 * * 1 account-refresh-sweep
`.trim();
