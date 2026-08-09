import { unstable_cache } from "next/cache";
import { getContentReport } from "@/lib/db/queries";

/**
 * Shared 60s-cached content report. Lives here (not in the route file) so
 * BOTH the /api/reports/content route and the /api/warm boot warmer hit the
 * SAME cache entry — warming through a different function would populate a
 * different key and do nothing for real requests. See the route file for the
 * staleness rationale.
 */
export const getContentReportCached = unstable_cache(
  async (params: Parameters<typeof getContentReport>[0]) =>
    getContentReport(params),
  ["content-report"],
  { revalidate: 60 },
);
