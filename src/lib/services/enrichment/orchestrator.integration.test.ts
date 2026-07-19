import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestProductionItem } from "@/test/factories";
import { enrichSingleItem, selectEnrichmentCandidates } from "./orchestrator";

describe("enrichSingleItem — unenrichable items", () => {
  it("stamps items with no matching enricher so they drop out of the sweep", async () => {
    // A Published item whose post_type maps to no enricher — mirrors the
    // null / unmapped post_type rows that jammed the enrichment queue in prod:
    // dispatch returned null, attempts + updated_at never moved, so they stayed
    // pinned to the front of the (attempts ASC, updated_at ASC) selection and
    // ate the whole batch every tick.
    const item = await createTestProductionItem({
      status: "Published",
      postType: "facebook_reel", // not in platformKindFromPostType
    });
    expect(item.enrichmentAttempts).toBe(0);

    const result = await enrichSingleItem(item.id);
    expect(result).toBeNull();

    const [row] = await db
      .select({
        attempts: productionItems.enrichmentAttempts,
        error: productionItems.enrichmentError,
        completedAt: productionItems.enrichmentCompletedAt,
      })
      .from(productionItems)
      .where(eq(productionItems.id, item.id));

    // Stamped to the max-attempts sentinel with a reason — but NOT marked
    // complete (nothing was enriched; there's just nothing to enrich).
    expect(row.attempts).toBe(5);
    expect(row.error).toContain("no-enricher-for-post-type:facebook_reel");
    expect(row.completedAt).toBeNull();

    // ...and it no longer comes back as a sweep candidate (attempts >= MAX and
    // a fresh updated_at, so both branches of the selection predicate exclude
    // it). Large limit so the assertion doesn't depend on global ordering.
    const candidates = await selectEnrichmentCandidates(10_000);
    expect(candidates).not.toContain(item.id);
  });

  it("fails soft on a permanent URL mismatch instead of throwing", async () => {
    // post_type routes to the Twitter enricher, but the published_link points
    // at a different host — a data inconsistency the enricher can never
    // resolve. Previously this threw out of the task every tick → graphile
    // retry storm → a Sentry page per exhaustion (HUBANDSPOKE-20/27/…). It must
    // now swallow, stamp, and give up.
    const item = await createTestProductionItem({
      status: "Published",
      postType: "x",
      publishedLink: "https://www.starterstory.com",
    });

    // Does NOT throw — the whole point of the fix.
    const result = await enrichSingleItem(item.id);
    expect(result).toBeNull();

    const [row] = await db
      .select({
        attempts: productionItems.enrichmentAttempts,
        error: productionItems.enrichmentError,
        completedAt: productionItems.enrichmentCompletedAt,
      })
      .from(productionItems)
      .where(eq(productionItems.id, item.id));

    // Maxed out (drops from the retry queue) with the reason preserved, but not
    // marked complete — a corrected link self-heals via the 24h sweep.
    expect(row.attempts).toBe(5);
    expect(row.error).toContain("is not a Twitter/X URL");
    expect(row.completedAt).toBeNull();

    const candidates = await selectEnrichmentCandidates(10_000);
    expect(candidates).not.toContain(item.id);
  });
});
