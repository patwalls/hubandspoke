/**
 * Loader for clip odds (`lib/clip-odds.ts`): every published post with real
 * views in the window the records need (365 days of clips + the 90-day usual
 * before the oldest), for one brand or every brand ("all").
 */
import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  computeFormatOdds,
  ODDS_MAX_AGE_DAYS,
  USUAL_WINDOW_DAYS,
  type FormatOdds,
  type PublishedRow,
} from "@/lib/clip-odds";

export async function loadFormatOdds(brand: string, now: Date = new Date()): Promise<Map<string, FormatOdds>> {
  const since = new Date(now.getTime() - (ODDS_MAX_AGE_DAYS + USUAL_WINDOW_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      brand: productionItems.brand,
      format: productionItems.format,
      platform: productionItems.platform,
      views: productionItems.views,
      publishedDate: productionItems.publishedDate,
    })
    .from(productionItems)
    .where(
      and(
        ...(brand === "all" ? [] : [eq(productionItems.brand, brand)]),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.views),
        isNotNull(productionItems.publishedDate),
        isNull(productionItems.deletedAt),
        gte(productionItems.publishedDate, since),
      ),
    );
  const published: PublishedRow[] = rows.map((r) => ({
    brand: r.brand,
    format: r.format,
    platform: Array.isArray(r.platform) ? ((r.platform as string[])[0] ?? null) : null,
    views: Number(r.views),
    publishedDate: String(r.publishedDate),
  }));
  return computeFormatOdds(published, now);
}
