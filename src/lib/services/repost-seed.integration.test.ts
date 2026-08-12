import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, productionItemMedia } from "@/lib/db/schema";
import {
  createTestProductionItem,
  getTestAccountId,
} from "@/test/factories";
import type { PostType } from "@/lib/platform-field-schemas";
import { seedRepostContent } from "./repost-seed";

// seedRepostContent seeds the source's caption verbatim into a v1
// content_drafts row (generatedBy: "copy:source") so cross-posts land
// with the original caption pre-filled rather than triggering AI
// generation.
describe("seedRepostContent — caption seeding", () => {
  it("seeds the source caption into the correct platform field", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      contentBody: "original tweet caption",
      accountId,
    });
    const target = await createTestProductionItem({
      postType: "instagram_reel",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      accountId,
    });

    await db.transaction(async (tx) => {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: target.id,
        postType: "instagram_reel",
        sourceContentBody: "original tweet caption",
        sourceLegacyMedia: null,
        actorUserId: target.editorUserId ?? "",
      });
    });

    const [draft] = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, target.id));

    expect(draft).toBeDefined();
    expect(draft.generatedBy).toBe("copy:source");
    expect(draft.isCurrent).toBe(true);
    expect(draft.version).toBe(1);
    // IG Reel caption field is "caption" per PLATFORM_FIELD_MAP
    expect((draft.content as Record<string, string>).caption).toBe(
      "original tweet caption",
    );
  });

  it("seeds into the correct field for each supported platform", async () => {
    const accountId = await getTestAccountId();
    const cases: Array<{ postType: PostType; expectedField: string }> = [
      { postType: "x", expectedField: "tweet" },
      { postType: "linkedin", expectedField: "body" },
      { postType: "threads", expectedField: "post" },
      { postType: "youtube_community", expectedField: "body" },
    ];

    for (const { postType, expectedField } of cases) {
      const source = await createTestProductionItem({ postType: "x", accountId });
      const target = await createTestProductionItem({
        postType,
        sourceType: "cross_post",
        repostedFromItemId: source.id,
        accountId,
      });

      await db.transaction(async (tx) => {
        await seedRepostContent(tx, {
          sourceId: source.id,
          repostId: target.id,
          postType,
          sourceContentBody: `caption for ${postType}`,
          sourceLegacyMedia: null,
          actorUserId: target.editorUserId ?? "",
        });
      });

      const [draft] = await db
        .select()
        .from(contentDrafts)
        .where(eq(contentDrafts.productionItemId, target.id));

      expect(draft.generatedBy).toBe("copy:source");
      expect((draft.content as Record<string, string>)[expectedField]).toBe(
        `caption for ${postType}`,
      );
    }
  });

  it("seeds empty string when source has no caption, without error", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      accountId,
    });
    const target = await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      accountId,
    });

    await expect(
      db.transaction(async (tx) => {
        await seedRepostContent(tx, {
          sourceId: source.id,
          repostId: target.id,
          postType: "x",
          sourceContentBody: null,
          sourceLegacyMedia: null,
          actorUserId: target.editorUserId ?? "",
        });
      }),
    ).resolves.not.toThrow();

    const [draft] = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, target.id));

    expect(draft).toBeDefined();
    expect((draft.content as Record<string, string>).tweet).toBe("");
  });
});

// seedRepostContent filters mirrored productionItemMedia rows by the
// target platform's allowed media kinds (from platform-media-rules.ts).
// Without the filter, cross-posting a video source to an image-only
// target (e.g. YouTube Community) would seed a video row the target's
// simulator rejects with "Community posts don't support video."
describe("seedRepostContent — target-aware media filter", () => {
  it("mirrors image carousel rows to a YouTube Community cross-post", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      contentBody: "source x tweet body",
      accountId,
    });
    // Two image rows on the source — mirrors the magicians PSA tweet
    // case (2-photo X carousel). YT Community supports up to 4 images
    // per the field schema; both should mirror through.
    await db.insert(productionItemMedia).values([
      {
        productionItemId: source.id,
        index: 0,
        kind: "image",
        s3Bucket: "test-bucket",
        s3Key: "src/photo-0.jpg",
        contentType: "image/jpeg",
      },
      {
        productionItemId: source.id,
        index: 1,
        kind: "image",
        s3Bucket: "test-bucket",
        s3Key: "src/photo-1.jpg",
        contentType: "image/jpeg",
      },
    ]);
    const target = await createTestProductionItem({
      postType: "youtube_community",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      accountId,
    });

    await db.transaction(async (tx) => {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: target.id,
        postType: "youtube_community",
        sourceContentBody: "source x tweet body",
        sourceLegacyMedia: null,
        actorUserId: target.editorUserId ?? "",
      });
    });

    const mirrored = await db
      .select()
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, target.id))
      .orderBy(productionItemMedia.index);
    expect(mirrored).toHaveLength(2);
    expect(mirrored.map((m) => m.s3Key)).toEqual([
      "src/photo-0.jpg",
      "src/photo-1.jpg",
    ]);
    expect(mirrored.every((m) => m.kind === "image")).toBe(true);
  });

  it("drops video rows when the target is image-only (YT Community)", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      accountId,
    });
    // A mixed carousel — one video, one image. YT Community accepts
    // images only, so only the image row should mirror.
    await db.insert(productionItemMedia).values([
      {
        productionItemId: source.id,
        index: 0,
        kind: "video",
        s3Bucket: "test-bucket",
        s3Key: "src/clip.mp4",
        contentType: "video/mp4",
      },
      {
        productionItemId: source.id,
        index: 1,
        kind: "image",
        s3Bucket: "test-bucket",
        s3Key: "src/still.jpg",
        contentType: "image/jpeg",
      },
    ]);
    const target = await createTestProductionItem({
      postType: "youtube_community",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      accountId,
    });

    await db.transaction(async (tx) => {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: target.id,
        postType: "youtube_community",
        sourceContentBody: "source body",
        sourceLegacyMedia: null,
        actorUserId: target.editorUserId ?? "",
      });
    });

    const mirrored = await db
      .select()
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, target.id));
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].kind).toBe("image");
    expect(mirrored[0].s3Key).toBe("src/still.jpg");
  });

  it("still mirrors video to a video-accepting target (X → IG Reel)", async () => {
    // Regression guard: the filter shouldn't change behavior for the
    // common same-kind cross-post path.
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "x",
      accountId,
    });
    await db.insert(productionItemMedia).values({
      productionItemId: source.id,
      index: 0,
      kind: "video",
      s3Bucket: "test-bucket",
      s3Key: "src/clip.mp4",
      contentType: "video/mp4",
    });
    const target = await createTestProductionItem({
      postType: "instagram_reel",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      accountId,
    });

    await db.transaction(async (tx) => {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: target.id,
        postType: "instagram_reel",
        sourceContentBody: "x video",
        sourceLegacyMedia: null,
        actorUserId: target.editorUserId ?? "",
      });
    });

    const mirrored = await db
      .select()
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, target.id));
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].kind).toBe("video");
  });
});
