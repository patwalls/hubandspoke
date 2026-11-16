import { revalidateTag } from "next/cache";
import { scheduleProductionRewarm } from "@/lib/report-rewarm";
import { productionReportTagsToExpire, touchedBrands } from "@/lib/production-report-tags";

// Next.js 16 changed revalidateTag to require a second `profile` arg for
// the new "use cache" system.  The two-arg form only targets "use cache"
// entries with a matching profile and does NOT invalidate unstable_cache
// entries or set pathWasRevalidated (router-cache bust).
// The single-arg form still works correctly for unstable_cache and sets
// pathWasRevalidated.  Cast to bypass the TypeScript overload.
const revalidateByTag = revalidateTag as (tag: string) => void;

/**
 * Call after any pipeline write. Pass the brands the write touched (the
 * item's brand, before and after a move) so only their In Production reports
 * (and /all's) go cold; with no brands, every brand's report expires.
 */
export function invalidateReportCaches(opts?: {
  brands?: ReadonlyArray<string | null | undefined>;
}): void {
  const brands = touchedBrands(opts?.brands);
  for (const tag of productionReportTagsToExpire(brands)) revalidateByTag(tag);
  revalidateByTag("content-report");
  // Anything that moves an item through the pipeline can admit or retire a
  // queue candidate (in-flight pairs, cooldowns, prior attempts).
  invalidateQueueCaches();
  // Rebuild In Production's report a few seconds later so the next person
  // to open it doesn't wait on the recompute (src/lib/report-rewarm.ts).
  scheduleProductionRewarm(brands);
}

/** The Repurposed / Repost / Cross-post candidate lists (see
 *  services/queue-candidates-cached.ts). Call after a dismissal or a kill —
 *  anything that changes the answer without touching the reports. */
export function invalidateQueueCaches(): void {
  revalidateByTag("queue-candidates");
}
