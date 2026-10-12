import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestProductionItem } from "@/test/factories";
import { persistEnrichmentUpdates } from "./orchestrator";

/**
 * Regression: HUBANDSPOKE-1Y / -2M. Drizzle wraps the Postgres unique-
 * violation ("Failed query: update ...") with code/constraint_name on
 * `cause` — the collision handler read the wrapper, never matched, and the
 * job retried to a permanent corpse while the item stayed un-enriched.
 */
describe("persistEnrichmentUpdates platform_content_id collision", () => {
  it("drops the colliding column, stamps the error, does not throw", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const taken = `collide-${suffix}`;
    const a = await createTestProductionItem({});
    const b = await createTestProductionItem({});
    await db
      .update(productionItems)
      .set({ platformContentId: taken })
      .where(eq(productionItems.id, a.id));

    // Must not throw (previously rethrew the wrapped error -> retry corpse).
    await persistEnrichmentUpdates(b.id, {
      platformContentId: taken,
      views: 123,
    });

    const [row] = await db
      .select({
        platformContentId: productionItems.platformContentId,
        views: productionItems.views,
        enrichmentError: productionItems.enrichmentError,
        enrichmentCompletedAt: productionItems.enrichmentCompletedAt,
      })
      .from(productionItems)
      .where(eq(productionItems.id, b.id));
    expect(row.platformContentId).toBeNull(); // colliding column dropped
    expect(row.views).toBe(123); // rest of the enrichment persisted
    expect(row.enrichmentError).toMatch(/collision/i);
    expect(row.enrichmentCompletedAt).not.toBeNull();
  });
});
