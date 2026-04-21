import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

// "Angus Warner on Bootstrapping" -> "angus-warner-on"
function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  return cleaned || "post";
}

async function isTaken(candidate: string): Promise<boolean> {
  const existing = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.utmCampaign, candidate))
    .limit(1);
  return existing.length > 0;
}

/**
 * Produce a unique CTA UTM campaign slug seeded from the item title. Shape:
 * `<slug>-<100..999>`. The partial unique index on utm_campaign is still the
 * source of truth — this just minimizes collisions before the INSERT.
 */
export async function generateUtmCampaign(
  title: string | null
): Promise<string> {
  const base = slugify(title ?? "post");
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Math.floor(Math.random() * 900 + 100);
    const candidate = `${base}-${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
