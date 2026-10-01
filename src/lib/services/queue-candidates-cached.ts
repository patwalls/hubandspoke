import { unstable_cache } from "next/cache";
import { selectSpokeCandidates } from "@/lib/services/spoke-candidates";
import { selectRepostCandidates } from "@/lib/services/repost-candidates";
import { selectCrossPostCandidates } from "@/lib/services/cross-post-candidates";

/**
 * The three live queue algorithms (Repurposed / Repost / Cross-post),
 * cached per brand. The queue page fetches all three on every mount — the
 * tab labels carry their counts — and each measured ~2.5s on prod when
 * they ran together (ten-odd sequential queries each, three at once on one
 * dyno). Candidates only change when something is triaged or a sweep
 * lands, so a 2-minute window is invisible day to day.
 *
 * Freshness: every route that changes the answer calls
 * `invalidateQueueCaches()` (promote, dismiss, kill, design item created),
 * and the queue's post-action refetch passes `?fresh=1`, which bypasses
 * AND resets the entry — so an operator never sees a row they just
 * dismissed. Same `unstable_cache` pattern as the production report.
 */
export const QUEUE_CANDIDATES_TAG = "queue-candidates";
const REVALIDATE_SEC = 120;

export const getSpokeCandidatesCached = unstable_cache(
  async (brand: string) => selectSpokeCandidates({ brand }),
  ["spoke-candidates"],
  { revalidate: REVALIDATE_SEC, tags: [QUEUE_CANDIDATES_TAG] },
);

export const getRepostCandidatesCached = unstable_cache(
  async (brand: string) => selectRepostCandidates({ brand }),
  ["repost-candidates"],
  { revalidate: REVALIDATE_SEC, tags: [QUEUE_CANDIDATES_TAG] },
);

export const getCrossPostCandidatesCached = unstable_cache(
  async (brand: string) => selectCrossPostCandidates({ brand }),
  ["cross-post-candidates"],
  { revalidate: REVALIDATE_SEC, tags: [QUEUE_CANDIDATES_TAG] },
);
