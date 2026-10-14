/**
 * Cover styles (2026-10-14): the gallery lists published Instagram
 * slideshow covers with the post's own format first; a style row is made
 * once per source post and its extraction queued; applying a style that
 * isn't read yet says so instead of failing blankly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designCoverStyles } from "@/lib/db/schema";
import { createTestFormat, createTestMedia, createTestProductionItem } from "@/test/factories";

const enqueue = vi.fn();
vi.mock("@/jobs/enqueue", () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }));
vi.mock("@/lib/s3", () => ({ getPresignedGetUrl: async (key: string) => `https://signed.test/${key}` }));
const { applyCoverStyle, coverStyleJobKey, ensureCoverStyle, listCoverStyles } = await import("./cover-styles");

beforeEach(() => enqueue.mockReset());

// Items need a real brand (the factory looks its account up), so the gallery
// also holds whatever real covers the local DB has: assertions are relative
// to the test's own rows, which outrank everything on views.
const brand = () => "starter-story";
const BIG = 1_000_000_000;

async function publishedCover(args: { brand: string; format: string; views: number; image?: boolean; status?: string; postType?: string }) {
  const item = await createTestProductionItem({ brand: args.brand, format: args.format, status: args.status ?? "Published", postType: args.postType ?? "instagram_post", views: args.views, hook: `Hook ${args.views}` });
  await createTestMedia({ productionItemId: item.id, index: 0, kind: args.image === false ? "video" : "image", contentType: args.image === false ? "video/mp4" : "image/jpeg", s3Key: `vitest/${item.id}.${args.image === false ? "mp4" : "jpg"}` });
  return item;
}

describe("listCoverStyles", () => {
  it("lists published Instagram image covers only, this format first, best first", async () => {
    const b = brand();
    const a = await createTestFormat({ brand: b });
    const other = await createTestFormat({ brand: b });
    const low = await publishedCover({ brand: b, format: a.name, views: BIG + 100 });
    const high = await publishedCover({ brand: b, format: a.name, views: BIG + 900 });
    const otherTop = await publishedCover({ brand: b, format: other.name, views: BIG + 5000 });
    const excluded = [
      await publishedCover({ brand: b, format: a.name, views: BIG + 99999, image: false }), // video cover — not a style
      await publishedCover({ brand: b, format: a.name, views: BIG + 99999, status: "Idea" }), // unpublished
      await publishedCover({ brand: b, format: a.name, views: BIG + 99999, postType: "instagram_reel" }), // not a slideshow
    ];

    const gallery = await listCoverStyles({ brand: b, format: a.name });
    expect(gallery.formats[0]).toBe(a.name);
    expect(gallery.formats).toContain(other.name);
    const mine = new Set([high.id, low.id, otherTop.id]);
    expect(gallery.styles.filter((s) => mine.has(s.productionItemId)).map((s) => s.productionItemId)).toEqual([high.id, low.id, otherTop.id]);
    expect(gallery.styles.some((s) => excluded.some((e) => e.id === s.productionItemId))).toBe(false);
    const top = gallery.styles.find((s) => s.productionItemId === high.id)!;
    expect(top).toMatchObject({ status: "none", styleId: null, hook: `Hook ${BIG + 900}`, views: BIG + 900 });
    expect(top.thumbnailUrl).toContain(`vitest/${high.id}.jpg`);
  });
});

describe("ensureCoverStyle", () => {
  it("creates the row once, queues the extraction, and re-queues a failed one", async () => {
    const b = brand();
    const fmt = await createTestFormat({ brand: b });
    const post = await publishedCover({ brand: b, format: fmt.name, views: 10 });
    try {
      const first = await ensureCoverStyle(post.id);
      const again = await ensureCoverStyle(post.id);
      expect(again.id).toBe(first.id);
      expect(first.status).toBe("pending");
      expect(enqueue).toHaveBeenCalledTimes(2); // the job key dedupes on the queue side
      expect(enqueue).toHaveBeenLastCalledWith("design-style-extract", { styleId: first.id }, expect.objectContaining({ jobKey: coverStyleJobKey(first.id) }));

      await db.update(designCoverStyles).set({ status: "failed", error: "boom" }).where(eq(designCoverStyles.id, first.id));
      const retried = await ensureCoverStyle(post.id);
      expect(retried).toMatchObject({ id: first.id, status: "pending", error: null });

      // Applying before it's read says so.
      const err = await applyCoverStyle({ productionItemId: post.id, styleId: first.id, canvas: null, currentHeadline: null, instruction: null }).catch((e) => e);
      expect(err.message).toMatch(/still being read/);
    } finally {
      await db.execute(sql`DELETE FROM design_cover_styles WHERE production_item_id = ${post.id}`);
    }
  });

  it("refuses a post with no image cover", async () => {
    const b = brand();
    const fmt = await createTestFormat({ brand: b });
    const post = await publishedCover({ brand: b, format: fmt.name, views: 10, image: false });
    await expect(ensureCoverStyle(post.id)).rejects.toThrow(/no cover image/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
