/**
 * A SPOKE candidate for a video post on X becomes a clip idea + its post +
 * a plain landscape edit — and re-opening the candidate lands on the same
 * one. Only formats that actually post video on X qualify.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems } from "@/lib/db/schema";
import {
  createTestFormat,
  createTestFormatChannel,
  createTestMedia,
  createTestProductionItem,
  createTestTranscript,
  getTestAccountId,
  getTestUserId,
} from "@/test/factories";
import { parseDoc } from "@/lib/clip-editor/doc";
import { ClipPostCreateError, findOrCreateClipPost, formatsForClipPosts } from "./from-candidate";
import type { pickPostClip } from "./pick-post-clip";

const madeItems: string[] = [];
afterEach(async () => {
  // The service's items aren't factory-tracked; their ideas/edits cascade.
  for (const id of madeItems.splice(0)) await db.delete(productionItems).where(eq(productionItems.id, id));
});

const segments = Array.from({ length: 20 }, (_, i) => ({ startSec: i * 5, endSec: i * 5 + 4.8, text: `line ${i}` }));
const introPick: typeof pickPostClip = async () => ({
  kind: "clip",
  pick: { startSec: 0, endSec: 34.8, hook: "He built 17 apps", angle: "Intro", rationale: "The intro", source: "llm" },
});

async function seed(opts: { videoHistory: boolean }) {
  const accountId = await getTestAccountId();
  const format = await createTestFormat({ instructions: "Clip out the intro and only the intro." });
  await createTestFormatChannel({ formatId: format.id, accountId, postType: "x" });
  for (let i = 0; i < 3; i++) {
    const past = await createTestProductionItem({ format: format.name, status: "Published", postType: "x" });
    if (opts.videoHistory) await createTestMedia({ productionItemId: past.id });
  }
  const pillar = await createTestProductionItem({ postType: "youtube_long", mediaS3Bucket: "vitest-bucket", mediaS3Key: "vitest/pillar.mp4" });
  await createTestTranscript({ productionItemId: pillar.id, segments });
  return { format, pillar, actorUserId: await getTestUserId() };
}

describe("findOrCreateClipPost", () => {
  it("makes the idea, its X post and a plain 16:9 edit, then reuses them", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: true });
    expect(await formatsForClipPosts("starter-story")).toContain(format.name);

    const first = await findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId, pick: introPick });
    madeItems.push(first.productionItemId);
    expect(first.created).toBe(true);

    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, first.productionItemId));
    expect(item).toMatchObject({ postType: "x", status: "Assigned", sourceClipIdeaId: first.clipIdeaId, pillarContentItemId: pillar.id, format: format.name });
    const [idea] = await db.select().from(clipIdeas).where(eq(clipIdeas.id, first.clipIdeaId));
    expect(idea).toMatchObject({ status: "suggested", acceptedProductionItemId: item.id, startSec: "0.000", endSec: "34.800" });

    const [edit] = await db.select().from(clipEdits).where(eq(clipEdits.clipIdeaId, first.clipIdeaId));
    const parsed = parseDoc(edit.doc);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.doc.canvas.width).toBeGreaterThan(parsed.doc.canvas.height);
    expect(parsed.doc.layers.filter((l) => l.type === "captions" || (l.type === "text" && l.role === "hook")).every((l) => !l.visible)).toBe(true);

    const again = await findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId, pick: async () => { throw new Error("must not re-pick"); } });
    expect(again).toEqual({ ...first, created: false });
  });

  it("refuses a format whose X posts don't carry video", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: false });
    await expect(findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId, pick: introPick })).rejects.toMatchObject({ reason: "not_video_format" });
  });

  it("refuses a whole-video Skill without creating anything", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: true });
    const err = await findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId, pick: async () => ({ kind: "whole_video", rationale: "full" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(ClipPostCreateError);
    expect(err.reason).toBe("whole_video");
    expect(await db.select().from(productionItems).where(eq(productionItems.pillarContentItemId, pillar.id))).toHaveLength(0);
  });
});

describe("findOrCreateClipPost concurrency", () => {
  it("two opens at once make one post", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: true });
    const [a, b] = await Promise.all([
      findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId, pick: introPick }),
      findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId, pick: introPick }),
    ]);
    madeItems.push(a.productionItemId, b.productionItemId);
    expect(a.productionItemId).toBe(b.productionItemId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await db.select().from(productionItems).where(eq(productionItems.pillarContentItemId, pillar.id))).toHaveLength(1);
  });
});
