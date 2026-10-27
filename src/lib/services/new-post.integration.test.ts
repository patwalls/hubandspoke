/**
 * The New menu's posts: a text post is the derivative item with the angle on
 * it and the Draft Algorithm queued; a reel picks its moment WITH the angle
 * and becomes a clip idea + post the clip editor opens on.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";
import {
  createTestFormat,
  createTestFormatChannel,
  createTestProductionItem,
  createTestTranscript,
  getTestAccountId,
  getTestUserId,
} from "@/test/factories";
import type { pickPostClip } from "./clip-editor/pick-post-clip";

const enqueue = vi.fn();
vi.mock("@/jobs/enqueue", () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }));
const { createNewPost, listNewPostFormats, listNewPostPillars, NewPostError } = await import("./new-post");

const madeItems: string[] = [];
afterEach(async () => {
  // The service's items aren't factory-tracked; their clip ideas are deleted with them.
  for (const id of madeItems.splice(0)) {
    await db.delete(productionItems).where(eq(productionItems.id, id));
  }
  enqueue.mockReset();
});

const flags = { designEditor: true, clipEditor: true };
const segments = Array.from({ length: 20 }, (_, i) => ({ startSec: i * 5, endSec: i * 5 + 4.8, text: `line ${i}` }));

async function pillar(opts: { video: boolean }) {
  const p = await createTestProductionItem({
    postType: "youtube_long",
    ...(opts.video ? { mediaS3Bucket: "vitest-bucket", mediaS3Key: "vitest/pillar.mp4" } : {}),
  });
  await createTestTranscript({ productionItemId: p.id, segments });
  return p;
}

describe("createNewPost", () => {
  it("a LinkedIn post: the item carries the angle and the Draft Algorithm is queued", async () => {
    const accountId = await getTestAccountId();
    const format = await createTestFormat();
    await createTestFormatChannel({ formatId: format.id, accountId, postType: "linkedin" });
    expect((await listNewPostFormats("starter-story", "linkedin_post", flags)).find((f) => f.id === format.id)?.editor).toBe("post");

    const p = await pillar({ video: false });
    const made = await createNewPost({ kind: "linkedin_post", brand: "starter-story", formatId: format.id, pillarId: p.id, angle: "  Lead with the SEO playbook  ", actorUserId: await getTestUserId(), flags });
    madeItems.push(made.productionItemId);

    expect(made.editor).toBe("post");
    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, made.productionItemId));
    expect(item).toMatchObject({ postType: "linkedin", format: format.name, status: "Assigned", pillarContentItemId: p.id, angle: "Lead with the SEO playbook", createdVia: "new-menu", accountId });
    expect(enqueue).toHaveBeenCalledWith("draft-algorithm-run", { productionItemId: made.productionItemId }, expect.anything());
  });

  it("a YouTube community post works with no format at all", async () => {
    const p = await pillar({ video: false });
    const made = await createNewPost({ kind: "youtube_community", brand: "starter-story", formatId: null, pillarId: p.id, angle: null, actorUserId: await getTestUserId(), flags });
    madeItems.push(made.productionItemId);
    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, made.productionItemId));
    expect(item).toMatchObject({ postType: "youtube_community", format: null, angle: null });
  });

  it("a reel: the angle steers the pick, and the clip idea + post are made for the clip editor", async () => {
    const accountId = await getTestAccountId();
    const format = await createTestFormat({ instructions: "Repackage a section with a hook." });
    await createTestFormatChannel({ formatId: format.id, accountId, postType: "instagram_reel" });
    const p = await pillar({ video: true });
    const seen: Parameters<typeof pickPostClip>[0][] = [];
    const pick: typeof pickPostClip = async (a) => {
      seen.push(a);
      return { kind: "clip", pick: { startSec: 40, endSec: 74.8, hook: "SEO got him 1,000 users", angle: format.name, rationale: "r", source: "llm" } };
    };

    const made = await createNewPost({ kind: "instagram_reel", brand: "starter-story", formatId: format.id, pillarId: p.id, angle: "the SEO part", actorUserId: await getTestUserId(), flags, pick });
    madeItems.push(made.productionItemId);

    expect(made.editor).toBe("clip");
    expect(seen[0]).toMatchObject({ destination: "short", angle: "the SEO part", skill: "Repackage a section with a hook." });
    const [idea] = await db.select().from(clipIdeas).where(eq(clipIdeas.id, made.clipIdeaId!));
    expect(idea).toMatchObject({ status: "suggested", targetFormat: format.name, startSec: "40.000", acceptedProductionItemId: made.productionItemId, angle: "the SEO part" });
    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, made.productionItemId));
    expect(item).toMatchObject({ postType: "instagram_reel", sourceClipIdeaId: idea.id, hook: "SEO got him 1,000 users", angle: "the SEO part" });
  });

  it("refuses a reel from a video that isn't archived, and a pillar from another brand", async () => {
    const p = await pillar({ video: false });
    const args = { kind: "instagram_reel", formatId: null, pillarId: p.id, angle: null, actorUserId: await getTestUserId(), flags };
    await expect(createNewPost({ ...args, brand: "starter-story" })).rejects.toBeInstanceOf(NewPostError);
    await expect(createNewPost({ ...args, brand: "my-first-million" })).rejects.toThrow(/another brand/);
  });
});

describe("listNewPostPillars", () => {
  it("gives each video its YouTube id, from the YouTube URL or the published link, for the dialog's preview", async () => {
    const fromUrl = await createTestProductionItem({ postType: "youtube_long", youtubeUrl: "https://www.youtube.com/watch?v=AbCdEfGhIj1" });
    const fromLink = await createTestProductionItem({ postType: "youtube_long", publishedLink: "https://youtu.be/ZyXwVuTsRq2" });
    const none = await createTestProductionItem({ postType: "youtube_long" });

    const pillars = await listNewPostPillars("starter-story");
    const id = (itemId: string) => pillars.find((p) => p.id === itemId)?.youtubeId;
    expect(id(fromUrl.id)).toBe("AbCdEfGhIj1");
    expect(id(fromLink.id)).toBe("ZyXwVuTsRq2");
    expect(id(none.id)).toBeNull();
  });
});
