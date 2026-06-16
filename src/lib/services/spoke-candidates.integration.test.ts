import { describe, expect, it } from "vitest";
import { selectSpokeCandidates } from "./spoke-candidates";
import { db } from "@/lib/db";
import { contentEvents } from "@/lib/db/schema";
import {
  createTestFormat,
  createTestProductionItem,
  getTestAccountId,
} from "@/test/factories";

const DAY_MS = 86_400_000;

// Smoke integration: exercises the full SQL path against the dev DB so a
// schema rename or a broken percentile_cont aggregate fails CI before it
// hits prod. Deeper assertion tests (in-flight skip, history boost, etc.)
// live in the unit suite — they target the pure pieces extracted from
// this function, where DB cohort noise doesn't interfere.

describe("selectSpokeCandidates (integration smoke)", () => {
  it("runs against the dev DB and returns the expected shape", async () => {
    const result = await selectSpokeCandidates({ brand: "starter-story" });
    expect(result).toMatchObject({
      items: expect.any(Array),
      stats: {
        rawPillars: expect.any(Number),
        rawFormats: expect.any(Number),
        rawPairs: expect.any(Number),
        droppedNoChannelCohort: expect.any(Number),
        droppedNoChildFormats: expect.any(Number),
        droppedInFlight: expect.any(Number),
        droppedCooldown: expect.any(Number),
        droppedBelowThreshold: expect.any(Number),
      },
      config: {
        pillarWindowDays: 730,
        channelCohortWindowDays: 365,
        formatCohortWindowDays: 90,
        spokeThreshold: 1.0,
      },
    });
    for (const item of result.items) {
      expect(item.spokeScore).toBeGreaterThanOrEqual(1.0);
      expect(item.id).toBe(`${item.pillar.id}:${item.format.id}`);
      expect(item.whySpoke).toBeTruthy();
      expect(item.breakdown.pillarStrength).toBeGreaterThan(0);
      expect(item.breakdown.formatFit).toBeGreaterThan(0);
      expect(item.breakdown.freshnessFactor).toBeGreaterThanOrEqual(0.15);
    }
    // Items are sorted by SPOKE desc.
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].spokeScore).toBeGreaterThanOrEqual(
        result.items[i].spokeScore,
      );
    }
  });

  it("returns empty items for a brand with no production_items", async () => {
    const result = await selectSpokeCandidates({
      brand: "definitely-not-a-real-brand-slug-xyz",
    });
    expect(result.items).toEqual([]);
    expect(result.stats.rawPillars).toBe(0);
  });

  // Proves the spoke_dismissed hide-list flips behavior: a (pillar, format)
  // pair that surfaces as a candidate disappears once a spoke_dismissed event
  // names that exact format. The content_events row cascades away when the
  // factory deletes the pillar in afterEach.
  it("hides a (pillar, format) pair after a spoke_dismissed event", async () => {
    const accountId = await getTestAccountId();

    // Parent format with one child — the only declared repurpose target.
    const parent = await createTestFormat({});
    const child = await createTestFormat({ parentFormatId: parent.id });

    // Decoys establish a low channel P60 so the real pillar's pillarStrength
    // (views ÷ P60) clears the SPOKE threshold. They themselves score < 1.0
    // (pillarStrength ≈ 1.0 × aged freshness) so they don't pollute results.
    for (let i = 0; i < 3; i++) {
      await createTestProductionItem({
        postType: "youtube_long",
        status: "Published",
        format: parent.name,
        accountId,
        views: 50,
        publishedAt: new Date(Date.now() - 60 * DAY_MS),
      });
    }

    const pillar = await createTestProductionItem({
      postType: "youtube_long",
      status: "Published",
      format: parent.name,
      accountId,
      views: 500_000,
      publishedAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const pairId = `${pillar.id}:${child.id}`;

    const before = await selectSpokeCandidates({ brand: "starter-story" });
    expect(before.items.some((i) => i.id === pairId)).toBe(true);

    // Dismiss the exact pair.
    await db.insert(contentEvents).values({
      contentItemId: pillar.id,
      eventType: "spoke_dismissed",
      payload: { type: "spoke_dismissed", formatId: child.id, reason: null },
    });

    const after = await selectSpokeCandidates({ brand: "starter-story" });
    expect(after.items.some((i) => i.id === pairId)).toBe(false);
    expect(after.stats.droppedDismissed).toBeGreaterThanOrEqual(1);
  });
});
