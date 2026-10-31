/**
 * Reads for the Monday winners email (milestone 4): every enabled brand's
 * strip winners (last 7 days) and format scoreboard (last 28 days). Rendering
 * rules are in `src/lib/winners/email.ts`; the send is the `winners-email`
 * task. Brand reads are shared across recipients — only the greeting differs.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { getFormatScoreboard, getRecentWinners } from "@/lib/db/winners";
import type { WinnersEmailBrand } from "@/lib/winners/email";

export async function loadWinnersEmailBrands(): Promise<WinnersEmailBrand[]> {
  const rows = await db
    .select({ slug: brands.slug, label: brands.label })
    .from(brands)
    .where(eq(brands.disabled, false))
    .orderBy(asc(brands.label));
  const out: WinnersEmailBrand[] = [];
  for (const b of rows) {
    const [winners, formats] = await Promise.all([getRecentWinners(b.slug), getFormatScoreboard(b.slug)]);
    out.push({ slug: b.slug, label: b.label, winners, formats });
  }
  return out;
}

export function firstNameOf(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}
