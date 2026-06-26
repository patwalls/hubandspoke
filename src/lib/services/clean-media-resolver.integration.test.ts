import { describe, it, expect } from "vitest";
import {
  createTestProductionItem,
  createTestMedia,
} from "@/test/factories";
import { DESCRIPT_EXPORT_URL_PREFIX } from "@/lib/descript";
import { resolveCleanSourceMedia } from "./clean-media-resolver";

const DESCRIPT_URL = `${DESCRIPT_EXPORT_URL_PREFIX}abc/clip.mp4`;
const TIKTOK_URL = "https://v16-webapp.tiktokcdn-us.com/xyz/video.mp4";

describe("resolveCleanSourceMedia (integration)", () => {
  it("returns the item's own clean media at depth 0", async () => {
    const item = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "original",
    });
    await createTestMedia({
      productionItemId: item.id,
      kind: "video",
      sourceUrl: null, // manual upload — clean
    });

    const res = await resolveCleanSourceMedia(item.id);
    expect(res.kind).toBe("archived");
    if (res.kind === "archived") {
      expect(res.origin.depth).toBe(0);
      expect(res.origin.itemId).toBe(item.id);
    }
  });

  // The headline case: a repost whose own video is a watermarked TikTok
  // download, with a Descript-export parent → resolve to the parent's clean media.
  it("walks past a watermarked repost to the clean Descript parent", async () => {
    const parent = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "original",
    });
    await createTestMedia({
      productionItemId: parent.id,
      kind: "video",
      sourceUrl: DESCRIPT_URL, // clean export
    });
    const repost = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "repost",
      repostedFromItemId: parent.id,
    });
    await createTestMedia({
      productionItemId: repost.id,
      kind: "video",
      sourceUrl: TIKTOK_URL, // watermarked download
    });

    const res = await resolveCleanSourceMedia(repost.id);
    expect(res.kind).toBe("archived");
    if (res.kind === "archived") {
      expect(res.origin.itemId).toBe(parent.id);
      expect(res.origin.depth).toBe(1);
      expect(res.label).toContain("Descript export");
    }
  });

  it("returns none when only watermarked media exists with no clean ancestor", async () => {
    const item = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "original",
    });
    await createTestMedia({
      productionItemId: item.id,
      kind: "video",
      sourceUrl: TIKTOK_URL,
    });

    const res = await resolveCleanSourceMedia(item.id);
    expect(res.kind).toBe("none");
  });

  it("is cycle-safe (self-referential lineage) and doesn't hang", async () => {
    const item = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "repost",
    });
    // Point it at itself to simulate a bad backfill cycle.
    const { db } = await import("@/lib/db");
    const { productionItems } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(productionItems)
      .set({ repostedFromItemId: item.id })
      .where(eq(productionItems.id, item.id));
    await createTestMedia({
      productionItemId: item.id,
      kind: "video",
      sourceUrl: TIKTOK_URL,
    });

    const res = await resolveCleanSourceMedia(item.id);
    expect(res.kind).toBe("none"); // resolved without hanging
  });
});
