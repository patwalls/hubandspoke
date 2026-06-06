import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts } from "@/lib/db/schema";
import { createTestProductionItem } from "@/test/factories";

// Mock only generateTrackedCta (no Anthropic / StarterStory calls in tests);
// keep the real TRACKED_CTA_VERSION export.
const generateTrackedCta = vi.fn();
vi.mock("./tracked-cta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracked-cta")>();
  return { ...actual, generateTrackedCta: (...args: unknown[]) => generateTrackedCta(...args) };
});

import { regenerateCtaForItem } from "./regenerate-cta";

const MOCK_CTA =
  "Here's the full story of how she pulled it off:\nhttps://go.starterstory.com/cta-test123";

async function insertCurrentDraft(productionItemId: string, content: object) {
  const [row] = await db
    .insert(contentDrafts)
    .values({
      productionItemId,
      version: 1,
      isCurrent: true,
      content: content as never,
      fieldSchemaSnapshot: { fields: [] } as never,
      generatedBy: "user",
      promptVersion: null,
      modelUsage: null,
      createdByUserId: null,
    })
    .returning();
  return row;
}

describe("regenerateCtaForItem", () => {
  beforeEach(() => {
    generateTrackedCta.mockReset();
    generateTrackedCta.mockResolvedValue({
      cta: MOCK_CTA,
      slug: "cta-test123",
      destinationUrl: "https://starterstory.com/stories/x?utm_source=x",
      targetType: "episode",
      leadMagnetId: null,
    });
  });

  it("clones a new draft with the tracked CTA and preserves the body", async () => {
    const item = await createTestProductionItem({ postType: "x" });
    await insertCurrentDraft(item.id, { tweet: "In @levelsio style, I have an 8% success rate." });

    const result = await regenerateCtaForItem({
      productionItemId: item.id,
      actorUserId: null,
    });

    expect(result.status).toBe("generated");
    expect(result.ctaPreview).toBe(MOCK_CTA);

    // generateTrackedCta saw the post body + channel.
    expect(generateTrackedCta).toHaveBeenCalledTimes(1);
    expect(generateTrackedCta.mock.calls[0][0]).toMatchObject({
      productionItemId: item.id,
      channel: "x",
      postBody: "In @levelsio style, I have an 8% success rate.",
    });

    // New current draft is v2 with cta set + tweet preserved.
    const [current] = await db
      .select()
      .from(contentDrafts)
      .where(
        and(
          eq(contentDrafts.productionItemId, item.id),
          eq(contentDrafts.isCurrent, true),
        ),
      );
    expect(current.version).toBe(2);
    const content = current.content as Record<string, unknown>;
    expect(content.cta).toBe(MOCK_CTA);
    expect(content.tweet).toBe("In @levelsio style, I have an 8% success rate.");
  });

  it("skips when the item has no current draft", async () => {
    const item = await createTestProductionItem({ postType: "x" });
    const result = await regenerateCtaForItem({
      productionItemId: item.id,
      actorUserId: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_current_draft");
    expect(generateTrackedCta).not.toHaveBeenCalled();
  });

  it("skips a post type with no CTA field (e.g. instagram_post)", async () => {
    const item = await createTestProductionItem({ postType: "instagram_post" });
    await insertCurrentDraft(item.id, { caption: "hi" });
    const result = await regenerateCtaForItem({
      productionItemId: item.id,
      actorUserId: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_cta_field");
    expect(generateTrackedCta).not.toHaveBeenCalled();
  });
});
