// Single source of truth for the post-age velocity checkpoints.
//
// Every post we publish gets a `capture-velocity-snapshot` job scheduled at
// each `offsetMinutes` after `publishedAt`. When the job fires it confirms
// the post's actual age is within `[windowMin, windowMax]` (retry-slack
// tolerance) and, if so, calls Scrape Creators once to capture a
// view-count row in `view_snapshots` tagged with `key`.
//
// The cross-post scanner reads these rows by `key` to compute velocity
// ratios against same-account-and-post-type baselines.
//
// Kept uniform across the codebase:
//   - src/jobs/tasks/capture-velocity-snapshot.ts (scheduler + task)
//   - src/lib/services/cross-post-scan.ts (reader + velocity gate)
//   - scripts/backfill-velocity-snapshot-schedule.mjs (mjs boundary —
//     keys are hardcoded but must match)

// Windows are non-overlapping by design — a given post age maps to at most
// one checkpoint. Adjacent gaps (e.g. ages 23-24 between 15m and 30m) are
// fine: they just represent "scheduled job fired unusually out of band,
// skip." The task's in-window check catches any fire outside these ranges.
// The later checkpoints (8h, 24h, 48h) have proportionally wider windows —
// worker retry backoff can stretch out to ~1h for very-retried jobs, and
// precision matters less once we're tracking decay instead of takeoff.
export const VELOCITY_CHECKPOINTS = [
  { key: "15m", offsetMinutes: 15, windowMin: 9, windowMax: 22 },
  { key: "30m", offsetMinutes: 30, windowMin: 23, windowMax: 45 },
  { key: "1h", offsetMinutes: 60, windowMin: 46, windowMax: 90 },
  { key: "2h", offsetMinutes: 120, windowMin: 100, windowMax: 179 },
  { key: "4h", offsetMinutes: 240, windowMin: 215, windowMax: 300 },
  { key: "8h", offsetMinutes: 480, windowMin: 420, windowMax: 720 },
  { key: "24h", offsetMinutes: 1440, windowMin: 1200, windowMax: 2160 },
  { key: "48h", offsetMinutes: 2880, windowMin: 2400, windowMax: 4320 },
] as const;

export type VelocityCheckpoint = (typeof VELOCITY_CHECKPOINTS)[number];
export type VelocityCheckpointKey = VelocityCheckpoint["key"];

/** Type-guard: narrows an arbitrary string to VelocityCheckpointKey. */
export function isVelocityCheckpointKey(
  value: string | null | undefined
): value is VelocityCheckpointKey {
  if (!value) return false;
  return VELOCITY_CHECKPOINTS.some((c) => c.key === value);
}
