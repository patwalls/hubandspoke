import { compressedCache } from "@/lib/compressed-cache";
import { getContentReport } from "@/lib/db/queries";

/**
 * Shared 60s-cached content report. Lives here (not in the route file) so
 * BOTH the /api/reports/content route and the /api/warm boot warmer hit the
 * SAME cache entry — warming through a different function would populate a
 * different key and do nothing for real requests. See the route file for the
 * staleness rationale. Gzipped: a YTD /all report is ~7.5 MB raw, over Next's
 * 2 MB entry limit (lib/compressed-cache.ts).
 */
export const getContentReportCached = compressedCache(
  async (params: Parameters<typeof getContentReport>[0]) =>
    getContentReport(params),
  ["content-report"],
  { revalidate: 60, tags: ["content-report"] },
);
