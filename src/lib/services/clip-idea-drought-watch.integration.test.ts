import { describe, it, expect } from "vitest";
import {
  createTestAccount,
  createTestClipIdea,
  createTestClipSection,
  createTestFormat,
  createTestFormatChannel,
  createTestProductionItem,
  createTestTranscript,
} from "@/test/factories";
import { findClipIdeaDroughts } from "./clip-idea-drought-watch";

const HOURS = 3600_000;

// The dev DB is a prod pull and may hold real gaps, so assert membership of
// the test's own (pillar, format) pairs, never totals.
async function gapKeys(): Promise<Set<string>> {
  const gaps = await findClipIdeaDroughts(1000);
  return new Set(gaps.map((g) => `${g.pillarId}:${g.formatId}`));
}

// A transcribed, sectioned youtube_long pillar whose writer ran 2h ago, on an
// account wired (via a root parent format's channel) to clippable children.
async function processedPillar() {
  const account = await createTestAccount({ platform: "youtube" });
  const parent = await createTestFormat({
    createdAt: new Date(Date.now() - 30 * 24 * HOURS),
  });
  await createTestFormatChannel({
    formatId: parent.id,
    accountId: account.id,
    postType: "youtube_long",
  });
  const pillar = await createTestProductionItem({
    accountId: account.id,
    postType: "youtube_long",
    publishedAt: new Date(Date.now() - 24 * HOURS),
  });
  await createTestTranscript({
    productionItemId: pillar.id,
    segments: [{ startSec: 0, endSec: 60, text: "vitest transcript" }],
  });
  const ranAt = new Date(Date.now() - 2 * HOURS);
  await createTestClipSection({ pillarId: pillar.id, createdAt: ranAt });
  return { parent, pillar, ranAt };
}

describe("findClipIdeaDroughts", () => {
  it("flags a format that existed when the writer ran but got 0 ideas", async () => {
    const { parent, pillar, ranAt } = await processedPillar();
    const fmt = await createTestFormat({
      parentFormatId: parent.id,
      isClippableFormat: true,
      createdAt: new Date(ranAt.getTime() - 24 * HOURS),
    });
    expect(await gapKeys()).toContain(`${pillar.id}:${fmt.id}`);
  });

  it("does not flag a format created after the writer ran (2026-10-21 Futurepedia X Quotables)", async () => {
    const { parent, pillar, ranAt } = await processedPillar();
    // A sibling format got hooks in the run, so generation clearly happened.
    const existing = await createTestFormat({
      parentFormatId: parent.id,
      isClippableFormat: true,
      createdAt: new Date(ranAt.getTime() - 24 * HOURS),
    });
    await createTestClipIdea({
      sourceProductionItemId: pillar.id,
      targetFormat: existing.name,
    });
    const added = await createTestFormat({
      parentFormatId: parent.id,
      isClippableFormat: true,
      // created_at defaults to now() — after the run.
    });
    const keys = await gapKeys();
    expect(keys).not.toContain(`${pillar.id}:${added.id}`);
    expect(keys).not.toContain(`${pillar.id}:${existing.id}`);
  });
});
