import { NextRequest, NextResponse } from "next/server";
import {
  runEnrichmentSweep,
  type SweepOptions,
} from "@/lib/services/enrichment/orchestrator";
import type { PlatformKind } from "@/lib/services/performance-decay";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const VALID_PLATFORMS: ReadonlyArray<PlatformKind> = [
  "youtube",
  "youtube_community",
  "instagram",
  "twitter",
  "threads",
  "linkedin",
  "tiktok",
];

/**
 * Backfill / on-demand enrichment runner. The hourly cron at xx:20 already
 * fires the default 50-item sweep via `/api/cron/tick` — this endpoint is
 * for selective re-runs:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://.../api/cron/enrichment-sweep?platform=instagram&limit=200"
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://.../api/cron/enrichment-sweep?platform=tiktok&limit=50&force=true"
 *
 * Same idempotency rules apply unless `force=true`. Returns a JSON summary
 * with credits spent so the caller can budget across multiple runs.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const limitParam = params.get("limit");
  const platformParam = params.get("platform");
  const forceParam = params.get("force");

  const options: SweepOptions = {};
  if (limitParam) {
    const n = parseInt(limitParam, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      return NextResponse.json(
        { error: "limit must be between 1 and 1000" },
        { status: 400 }
      );
    }
    options.limit = n;
  }
  if (platformParam) {
    if (!VALID_PLATFORMS.includes(platformParam as PlatformKind)) {
      return NextResponse.json(
        {
          error: `platform must be one of: ${VALID_PLATFORMS.join(", ")}`,
        },
        { status: 400 }
      );
    }
    options.platform = platformParam as PlatformKind;
  }
  if (forceParam === "true") options.force = true;
  if (params.get("withMedia") === "true") options.withMedia = true;

  const summary = await runEnrichmentSweep(options);
  return NextResponse.json({ ok: true, options, summary });
}
