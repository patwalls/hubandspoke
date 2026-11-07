import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestClipIdea, createTestProductionItem } from "@/test/factories";
import { latestClipIdeaBatches } from "./pillar-clip-ideas";

describe("latestClipIdeaBatches — what a video's Clip Ideas panel lists", () => {
  it("lists the newest batch of EVERY format, not just the format generated last", async () => {
    const pillar = await createTestProductionItem({});
    const t = (min: number) => new Date(Date.UTC(2026, 10, 7, 12, min));
    const oldReels = randomUUID();
    const newReels = randomUUID();
    const quotables = randomUUID();
    const legacy = randomUUID();
    await createTestClipIdea({ sourceProductionItemId: pillar.id, targetFormat: "Reels", batchId: oldReels, createdAt: t(0) });
    await createTestClipIdea({ sourceProductionItemId: pillar.id, targetFormat: "Reels", batchId: newReels, createdAt: t(10) });
    await createTestClipIdea({ sourceProductionItemId: pillar.id, targetFormat: "Reels", batchId: newReels, createdAt: t(10) });
    // Generated after the Reels — before the fix, the panel showed only these.
    await createTestClipIdea({ sourceProductionItemId: pillar.id, targetFormat: "X Quotables", batchId: quotables, createdAt: t(20) });
    // Pre-format ideas count as a format of their own.
    await createTestClipIdea({ sourceProductionItemId: pillar.id, targetFormat: null, batchId: legacy, createdAt: t(5) });

    const { batchIds, createdAt } = await latestClipIdeaBatches(pillar.id);
    expect([...batchIds].sort()).toEqual([newReels, quotables, legacy].sort());
    expect(createdAt?.toISOString()).toBe(t(20).toISOString());
  });

  it("is empty for a video with no ideas", async () => {
    const pillar = await createTestProductionItem({});
    expect(await latestClipIdeaBatches(pillar.id)).toEqual({ batchIds: [], createdAt: null });
  });
});
