/**
 * A SPOKE candidate for a video post on X becomes a clip idea + its post +
 * a plain landscape edit — and re-opening the candidate lands on the same
 * one. Only formats that actually post video on X qualify.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, formats, productionItems } from "@/lib/db/schema";
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
import { attachClipPostToItem, ClipPostCreateError, findOrCreateClipPost, formatsForClipPosts } from "./from-candidate";
import type { pickPostClip } from "./pick-post-clip";
import { skillHash } from "./skill-clip-check";

// The Skill check is a Haiku call: tests only read verdicts they seed.
vi.mock("@/lib/services/clip-editor/skill-clip-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/clip-editor/skill-clip-check")>();
  return { ...actual, skillChecksFor: (rows: Parameters<typeof actual.skillChecksFor>[0]) => actual.skillChecksFor(rows, { classify: async () => null }) };
});

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

const INTRO_SKILL = "Clip out the intro and only the intro.";

async function seed(opts: { videoHistory: boolean; skillVerdict?: "clip" | "whole_video" | "none" }) {
  const accountId = await getTestAccountId();
  const format = await createTestFormat({
    instructions: INTRO_SKILL,
    clipPostSkillCheck: opts.skillVerdict
      ? { skillHash: skillHash(INTRO_SKILL), verdict: opts.skillVerdict, reason: "Seeded.", checkedAt: new Date().toISOString() }
      : null,
  });
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

describe("which formats open in the clip editor", () => {
  it("a Skill that cuts a clip is enough — a brand-new format with no video history qualifies", async () => {
    const { format } = await seed({ videoHistory: false, skillVerdict: "clip" });
    expect(await formatsForClipPosts("starter-story")).toContain(format.name);
  });

  it("video history is enough when the Skill doesn't say", async () => {
    const { format } = await seed({ videoHistory: true, skillVerdict: "none" });
    expect(await formatsForClipPosts("starter-story")).toContain(format.name);
  });

  it("a whole-video Skill stays classic even with video history", async () => {
    const { format } = await seed({ videoHistory: true, skillVerdict: "whole_video" });
    expect(await formatsForClipPosts("starter-story")).not.toContain(format.name);
  });

  it("a format with a design template never opens the clip editor, even with a clip Skill and video history", async () => {
    const { format } = await seed({ videoHistory: true, skillVerdict: "clip" });
    // Any stored doc counts (formatsWithDesignTemplate only checks presence).
    await db.update(formats).set({ designTemplate: { pages: [] } as never }).where(eq(formats.id, format.id));
    expect(await formatsForClipPosts("starter-story")).not.toContain(format.name);
  });

  it("a Skill read before an edit is ignored until it is read again", async () => {
    const { format } = await seed({ videoHistory: false, skillVerdict: "clip" });
    await db.update(formats).set({ instructions: "Write a thread about the episode." }).where(eq(formats.id, format.id));
    expect(await formatsForClipPosts("starter-story")).not.toContain(format.name);
  });
});

describe("attachClipPostToItem (All / Triggered rows)", () => {
  it("links the picked intro to the EXISTING item, keeps it an Idea, and reuses it on re-open", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: false, skillVerdict: "clip" });
    const triggered = await createTestProductionItem({
      format: format.name, status: "Idea", postType: "x", sourceType: "repurposed", pillarContentItemId: pillar.id, hook: "Their hook",
    });

    const first = await attachClipPostToItem({ productionItemId: triggered.id, actorUserId, pick: introPick });
    expect(first).toMatchObject({ productionItemId: triggered.id, created: true });

    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, triggered.id));
    expect(item).toMatchObject({ status: "Idea", sourceClipIdeaId: first.clipIdeaId, hook: "Their hook" });
    const [idea] = await db.select().from(clipIdeas).where(eq(clipIdeas.id, first.clipIdeaId));
    expect(idea).toMatchObject({ status: "suggested", acceptedProductionItemId: triggered.id, sourceProductionItemId: pillar.id, startSec: "0.000", endSec: "34.800" });
    expect(await db.select().from(clipEdits).where(eq(clipEdits.clipIdeaId, first.clipIdeaId))).toHaveLength(1);
    // No second item was made for the pair.
    expect(await db.select().from(productionItems).where(eq(productionItems.pillarContentItemId, pillar.id))).toHaveLength(1);

    const again = await attachClipPostToItem({ productionItemId: triggered.id, actorUserId, pick: async () => { throw new Error("must not re-pick"); } });
    expect(again).toEqual({ ...first, created: false });
  });

  it("refuses an item that has left Idea, or isn't a repurposed item with a source video", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: false, skillVerdict: "clip" });
    const assigned = await createTestProductionItem({ format: format.name, status: "Assigned", postType: "x", sourceType: "repurposed", pillarContentItemId: pillar.id });
    await expect(attachClipPostToItem({ productionItemId: assigned.id, actorUserId, pick: introPick })).rejects.toMatchObject({ reason: "not_eligible" });
    const orphan = await createTestProductionItem({ format: format.name, status: "Idea", postType: "x", sourceType: "repurposed", pillarContentItemId: null });
    await expect(attachClipPostToItem({ productionItemId: orphan.id, actorUserId, pick: introPick })).rejects.toMatchObject({ reason: "not_eligible" });
  });

  it("refuses a format that doesn't open in the clip editor", async () => {
    const { format, pillar, actorUserId } = await seed({ videoHistory: false, skillVerdict: "none" });
    const item = await createTestProductionItem({ format: format.name, status: "Idea", postType: "x", sourceType: "repurposed", pillarContentItemId: pillar.id });
    await expect(attachClipPostToItem({ productionItemId: item.id, actorUserId, pick: introPick })).rejects.toMatchObject({ reason: "not_video_format" });
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
