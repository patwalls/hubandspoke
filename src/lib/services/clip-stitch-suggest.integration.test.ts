/**
 * Clip stitching M3: a pre-v2 section gets its stitch-in lines once, stored
 * on the row (`[]` when there are none), and is never asked again.
 */
import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipSections } from "@/lib/db/schema";
import { createTestClipSection, createTestProductionItem, createTestTranscript } from "@/test/factories";
import { suggestStitchForSection } from "./clip-stitch-suggest";

const lines: Array<[number, number, string]> = [
  [0, 10, "first we picked one tiny niche nobody else wanted to serve"],
  [100, 110, "then we cold emailed every agency in that niche for a month"],
  [300, 308, "and by the end of the year it was doing forty grand a month"],
];
const words = lines.flatMap(([s, e, text]) => {
  const ws = text.split(" ");
  const step = (e - s) / ws.length;
  return ws.map((word, i) => ({ word, startSec: s + i * step, endSec: s + (i + 1) * step }));
});

function client(quotes: unknown[]) {
  const create = vi.fn(async () => ({
    content: [{ type: "tool_use", name: "suggest_supporting_quotes", input: { supportingQuotes: quotes } }],
  }));
  return { create, client: { messages: { create } } as unknown as Anthropic };
}

async function seed() {
  const pillar = await createTestProductionItem({ postType: "youtube_long" });
  await createTestTranscript({
    productionItemId: pillar.id,
    segments: lines.map(([startSec, endSec, text]) => ({ startSec, endSec, text })),
    words,
  });
  return createTestClipSection({ pillarId: pillar.id, startSec: 95, endSec: 115 });
}

const stored = async (id: string) =>
  (await db.select({ m: clipSections.supportingMoments }).from(clipSections).where(eq(clipSections.id, id)))[0].m;

describe("suggestStitchForSection", () => {
  it("stores located lines for a pre-v2 section, dropping one inside the clip, then never asks again", async () => {
    const section = await seed();
    const fake = client([
      { quote: "and by the end of the year it was doing forty grand a month", role: "payoff", why: "the result" },
      { quote: "then we cold emailed every agency in that niche", role: "detail", why: "already in the clip" },
    ]);
    expect(await suggestStitchForSection(section.id, undefined, fake.client)).toEqual({ status: "ok", moments: 1 });
    const m = await stored(section.id);
    expect(m).toHaveLength(1);
    expect(m![0]).toMatchObject({ role: "payoff", startSec: 300, endSec: 308 });

    expect(await suggestStitchForSection(section.id, undefined, fake.client)).toEqual({ status: "skip", reason: "not-needed" });
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("stores [] when there is nothing to stitch, so the editor stops asking", async () => {
    const section = await seed();
    await suggestStitchForSection(section.id, undefined, client([]).client);
    expect(await stored(section.id)).toEqual([]);
  });
});
