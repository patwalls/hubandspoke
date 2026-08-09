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
  // Production-pipeline report (the queue page SSRs this; 1.5-2.7s cold).
  for (const b of brands.map((x) => x.slug)) {
    const t = Date.now();
    try {
      const { getProductionReportCached } = await import(
        "@/lib/services/production-report"
      );
      await getProductionReportCached(b, false);
      timings[`production:${b}`] = Date.now() - t;
    } catch {
      timings[`production:${b}`] = -1;
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

  // EXECUTE the detail service for the most recent published item — bare
  // route-module imports measured 6ms (the bundler folds them; nothing
  // actually initializes). Running the service warms the real cost: module
  // graph, pg pool, S3 presign client, and query plans. This is the same
  // function the detail page SSRs, so the first human detail view after a
  // deploy is served warm.
  {
    const t = Date.now();
    try {
      const { getProductionItemDetail } = await import(
        "@/lib/services/production-item-detail"
      );
      const { db } = await import("@/lib/db");
      const { productionItems } = await import("@/lib/db/schema");
      const { desc, isNotNull } = await import("drizzle-orm");
      const [recent] = await db
        .select({ id: productionItems.id })
        .from(productionItems)
        .where(isNotNull(productionItems.publishedDate))
        .orderBy(desc(productionItems.publishedDate))
        .limit(1);
      if (recent) await getProductionItemDetail(recent.id);
      timings["detail-service"] = Date.now() - t;
    } catch {
      timings["detail-service"] = -1;
    }
  }

  return NextResponse.json({ ok: true, totalMs: Date.now() - t0, timings });
}
