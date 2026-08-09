import { NextRequest, NextResponse } from "next/server";
import { getContentReportCached } from "@/lib/db/queries-cached";
import { getScCreditsExhaustionState } from "@/lib/services/sc-credits-watch";
import { getDescriptCreditsExhaustionState } from "@/lib/services/descript-credits-watch";
import { getEnabledBrands } from "@/lib/db/brands";
import { format, subDays } from "date-fns";
import { todayInclusiveOfUtc } from "@/lib/dates";

/**
 * Boot-time warmer — called by scripts/boot-web.sh a few seconds after the
 * dyno starts (and re-callable any time, e.g. by the ops loop). Two jobs:
 *
 * 1. Import + execute the heavy server modules (drizzle graph, queries.ts)
 *    so the FIRST real user after a deploy doesn't pay ~2s of lazy route
 *    initialization (measured: detail API 2.28s cold -> 59ms warm).
 * 2. Pre-populate the 60s report cache for every enabled brand's default
 *    view + the credits banners — the exact requests every dashboard load
 *    fires — so a deploy never presents a cold cache to a human.
 *
 * Auth: Bearer CRON_SECRET (same convention as /api/cron/tick). Unauthed
 * requests are a cheap 401 noop.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const today = new Date();
  const startDate = format(subDays(today, 90), "yyyy-MM-dd");
  const endDate = todayInclusiveOfUtc();
  const timings: Record<string, number> = {};

  const brands = await getEnabledBrands();
  const defaults = {
    startDate,
    endDate,
    viewType: "weekly" as const,
    platform: "all",
    platformKey: "all",
    accountId: "all",
    postType: "all",
    format: "all",
    source: "all",
    provenOnly: false,
    origin: "all",
  };

  // Sequential on purpose: this runs on the live dyno right after boot —
  // don't spike the DB pool while real requests may be arriving.
  for (const b of [...brands.map((x) => x.slug), "all"]) {
    const t = Date.now();
    try {
      await getContentReportCached({ brand: b, ...defaults });
      timings[`report:${b}`] = Date.now() - t;
    } catch {
      timings[`report:${b}`] = -1;
    }
  }
  try {
    const t = Date.now();
    await Promise.all([
      getScCreditsExhaustionState(),
      getDescriptCreditsExhaustionState(),
    ]);
    timings["credits"] = Date.now() - t;
  } catch {
    timings["credits"] = -1;
  }

  return NextResponse.json({ ok: true, totalMs: Date.now() - t0, timings });
}
