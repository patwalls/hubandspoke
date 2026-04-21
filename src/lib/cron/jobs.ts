import { syncFromNotion } from "@/lib/services/notion-sync";
import { syncPerformanceData } from "@/lib/services/performance-decay";
import { checkSSThresholds } from "@/lib/services/threshold-monitor";
import { runEvergreenScan } from "@/lib/services/evergreen-scan";
import { runCrossPostScan } from "@/lib/services/cross-post-scan";
import { syncAllMATG } from "@/lib/services/matg-sync";

type TenMinSlot = 0 | 10 | 20 | 30 | 40 | 50;

export type Schedule =
  | { every: "10min" }
  | { every: "hour"; atMinute: TenMinSlot }
  | { every: "day"; atUtcHour: number; atMinute?: TenMinSlot };

export interface CronJob {
  name: string;
  schedule: Schedule;
  run: () => Promise<unknown>;
}

/**
 * Single source of truth for scheduled jobs. Add an entry, deploy.
 * Heroku Scheduler hits /api/cron/tick every 10 minutes; the tick
 * dispatcher runs whichever jobs match the current 10-minute window.
 *
 * Schedule shapes:
 *   - { every: "10min" }                                  → fires every tick
 *   - { every: "hour",  atMinute: 0|10|20|30|40|50 }      → fires once per hour at the given 10-min slot
 *   - { every: "day",   atUtcHour: 13, atMinute: 0 }      → fires once per day at HH:MM UTC (atMinute defaults to 0)
 */
export const CRON_JOBS: CronJob[] = [
  {
    // Unified metrics refresh for every Published item on every SC-supported
    // platform (YouTube + Community, Instagram, Twitter, Threads, LinkedIn).
    // Decay-tier gated + credit-capped so archival items don't burn credits.
    name: "performance-decay",
    schedule: { every: "hour", atMinute: 0 },
    run: () => syncPerformanceData(),
  },
  {
    name: "notion-sync",
    schedule: { every: "hour", atMinute: 30 },
    run: () => syncFromNotion(),
  },
  {
    name: "matg-sync",
    schedule: { every: "day", atUtcHour: 13 },
    run: () => syncAllMATG(),
  },
  {
    name: "ss-threshold-check",
    schedule: { every: "day", atUtcHour: 14 },
    run: () => checkSSThresholds(),
  },
  {
    name: "evergreen-scan",
    schedule: { every: "day", atUtcHour: 15 },
    run: () => runEvergreenScan(),
  },
  {
    name: "cross-post-scan",
    schedule: { every: "day", atUtcHour: 16 },
    run: () => runCrossPostScan(),
  },
];

export function shouldRunNow(s: Schedule, now: Date = new Date()): boolean {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const slot = (Math.floor(minute / 10) * 10) as TenMinSlot;

  if (s.every === "10min") return true;
  if (s.every === "hour") return s.atMinute === slot;
  if (s.every === "day") return hour === s.atUtcHour && (s.atMinute ?? 0) === slot;
  return false;
}
