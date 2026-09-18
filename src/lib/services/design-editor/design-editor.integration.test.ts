/**
 * The design editor's workflow side effects: exporting moves the item like
 * Accept does, queues one render, seeds the caption, and installs pages as
 * the item's carousel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, contentEvents, designDocs, designRenders, productionItemMedia, productionItems } from "@/lib/db/schema";
import { createTestMedia, createTestProductionItem, getTestUserId } from "@/test/factories";
import { buildPlaybookDoc } from "@/lib/design-editor/playbook-template";

const enqueue = vi.fn();
vi.mock("@/jobs/enqueue", () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }));
const { exportDesign } = await import("./export");
const { installDesignMedia, DESIGN_EDITOR_SOURCE_PREFIX } = await import("./install-design-media");
const { saveDesignDoc } = await import("./save");

beforeEach(() => enqueue.mockReset());

const brief = { stat: "$1K", statUnit: "/mo", headline: "hello", highlights: [], footer: "f", notesTitle: "t", phases: [{ heading: "h", body: "b" }], caption: "The AI caption", clips: [], pillLabel: "P" };

async function seed(status = "Idea") {
  const item = await createTestProductionItem({ status, sourceType: "repurposed", postType: "instagram_post", format: "Instagram PLAYBOOK" });
  const [design] = await db
    .insert(designDocs)
    .values({ productionItemId: item.id, doc: buildPlaybookDoc(brief, { photo: null, source: null, channel: { name: "S", subscribers: "" } }), brief })
    .returning();
  return { item, design };
}

describe("exportDesign", () => {
  it("assigns an Idea item like Accept, records the event, seeds the caption, queues one render", async () => {
    const userId = await getTestUserId();
    const { item, design } = await seed();
    const r = await exportDesign({ productionItemId: item.id, actorUserId: userId });
    expect(r.reExport).toBe(false);

    const [after] = await db.select().from(productionItems).where(eq(productionItems.id, item.id));
    expect(after).toMatchObject({ status: "Assigned", editorUserId: userId });
    const events = await db.select({ type: contentEvents.eventType }).from(contentEvents).where(eq(contentEvents.contentItemId, item.id));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["accepted", "tool_action"]));

    const [draft] = await db.select().from(contentDrafts).where(and(eq(contentDrafts.productionItemId, item.id), eq(contentDrafts.isCurrent, true)));
    expect(draft.content).toMatchObject({ caption: "The AI caption" });
    expect(draft.fieldSchemaSnapshot).toBeTruthy();

    const renders = await db.select().from(designRenders).where(eq(designRenders.designDocId, design.id));
    expect(renders).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith("design-render", { renderId: renders[0].id }, expect.objectContaining({ queueName: "media-heavy" }));
  });

  it("never overwrites a caption a person wrote, and re-export supersedes the earlier render", async () => {
    const userId = await getTestUserId();
    const { item, design } = await seed("Assigned");
    await db.insert(contentDrafts).values({ productionItemId: item.id, version: 1, isCurrent: true, content: { caption: "Human wrote this" }, fieldSchemaSnapshot: { version: 1, fields: [] }, generatedBy: "user:edit" });
    await exportDesign({ productionItemId: item.id, actorUserId: userId });
    await exportDesign({ productionItemId: item.id, actorUserId: userId });
    const [draft] = await db.select().from(contentDrafts).where(and(eq(contentDrafts.productionItemId, item.id), eq(contentDrafts.isCurrent, true)));
    expect(draft.content).toMatchObject({ caption: "Human wrote this" });
    const renders = await db.select({ status: designRenders.status }).from(designRenders).where(eq(designRenders.designDocId, design.id)).orderBy(asc(designRenders.createdAt));
    expect(renders.map((r) => r.status)).toEqual(["superseded", "queued"]);
  });
});

describe("installDesignMedia", () => {
  it("pages become slides 0…n-1, other media follows, a re-export replaces only the previous render", async () => {
    const item = await createTestProductionItem({});
    await createTestMedia({ productionItemId: item.id, index: 0, s3Key: "vitest/manual.jpg", kind: "image" });
    const args = { productionItemId: item.id, s3Bucket: "vitest-bucket" };
    const png = (s3Key: string) => ({ s3Key, sizeBytes: 1, kind: "image" as const, contentType: "image/png", posterS3Key: null });
    await installDesignMedia({ ...args, renderId: "r1", pages: [png("vitest/p1.png"), png("vitest/p2.png")] });
    await installDesignMedia({
      ...args,
      renderId: "r2",
      pages: [png("vitest/q1.png"), png("vitest/q2.png"), { s3Key: "vitest/q3.mp4", sizeBytes: 9, kind: "video", contentType: "video/mp4", posterS3Key: "vitest/q3-poster.jpg" }],
    });
    const media = await db
      .select({ index: productionItemMedia.index, s3Key: productionItemMedia.s3Key, sourceUrl: productionItemMedia.sourceUrl, kind: productionItemMedia.kind, posterS3Key: productionItemMedia.posterS3Key })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, item.id))
      .orderBy(asc(productionItemMedia.index));
    expect(media.map((m) => [m.index, m.s3Key])).toEqual([[0, "vitest/q1.png"], [1, "vitest/q2.png"], [2, "vitest/q3.mp4"], [3, "vitest/manual.jpg"]]);
    expect(media[0].sourceUrl).toBe(`${DESIGN_EDITOR_SOURCE_PREFIX}r2`);
    // A video slide keeps its kind and poster so the carousel can show a thumb.
    expect(media[2]).toMatchObject({ kind: "video", posterS3Key: "vitest/q3-poster.jpg" });
    const [row] = await db.select({ key: productionItems.mediaS3Key }).from(productionItems).where(eq(productionItems.id, item.id));
    expect(row.key).toBe("vitest/q1.png");
  });
});

describe("saveDesignDoc", () => {
  it("rejects a stale revision", async () => {
    const { item } = await seed();
    const doc = buildPlaybookDoc(brief, { photo: null, source: null, channel: { name: "S", subscribers: "" } });
    expect(await saveDesignDoc({ productionItemId: item.id, expectedRevision: 1, doc })).toEqual({ ok: true, revision: 2 });
    expect(await saveDesignDoc({ productionItemId: item.id, expectedRevision: 1, doc })).toEqual({ ok: false, reason: "conflict", currentRevision: 2 });
  });
});
