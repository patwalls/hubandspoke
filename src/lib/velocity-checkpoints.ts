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

export const VELOCITY_CHECKPOINTS = [
  { key: "15m", offsetMinutes: 15, windowMin: 8, windowMax: 25 },
  { key: "30m", offsetMinutes: 30, windowMin: 20, windowMax: 45 },
  { key: "1h", offsetMinutes: 60, windowMin: 45, windowMax: 90 },
  { key: "2h", offsetMinutes: 120, windowMin: 100, windowMax: 150 },
  { key: "4h", offsetMinutes: 240, windowMin: 210, windowMax: 270 },
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
