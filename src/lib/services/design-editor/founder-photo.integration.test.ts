/**
 * Founder photos the team uploads are gold: every post from the same video
 * leads with them, ahead of the AI's frame pick (which picked the host, not
 * the guest, on 2026-10-16).
 */
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { designDocs } from "@/lib/db/schema";
import { createTestDesignDoc, createTestDesignFrame, createTestDesignPhoto, createTestFormat, createTestProductionItem, getTestUserId } from "@/test/factories";
import { buildTechStackTemplate } from "@/lib/design-editor/tech-stack-template";
import type { DesignDoc, DesignImageSource } from "@/lib/design-editor/doc";

vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/s3", async (orig) => ({ ...(await orig<typeof import("@/lib/s3")>()), getPresignedGetUrl: async (key: string) => `https://signed.test/${key}` }));
const { coverPhotoFor, loadDesignEditorSession } = await import("./session");

const s3 = (key: string): DesignImageSource => ({ kind: "s3", bucket: "vitest-bucket", key });
const photoSlotSrcs = (doc: DesignDoc) => doc.pages.flatMap((p) => p.elements.flatMap((e) => (e.type === "image" && e.slot?.kind === "photo" ? [e.src] : [])));

describe("founder photos lead the cover", () => {
  it("coverPhotoFor picks the first uploaded founder photo over the AI's frame pick", async () => {
    const source = await createTestProductionItem({});
    await createTestDesignFrame({ productionItemId: source.id, isPick: true, s3Key: "vitest/pick.jpg" });
    expect(await coverPhotoFor(source.id)).toEqual(s3("vitest/pick.jpg"));
    await createTestDesignPhoto({ productionItemId: source.id, s3Key: "vitest/founder-1.jpg", createdAt: new Date(Date.now() - 60_000) });
    await createTestDesignPhoto({ productionItemId: source.id, s3Key: "vitest/founder-2.jpg" });
    await createTestDesignPhoto({ productionItemId: source.id, kind: "screen", s3Key: "vitest/screen.jpg", createdAt: new Date(Date.now() - 120_000) });
    expect(await coverPhotoFor(source.id)).toEqual(s3("vitest/founder-1.jpg"));
  });

  it("opening a post drafted before the upload swaps the frame pick for the founder photo, but keeps a hand-picked picture", async () => {
    const template = buildTechStackTemplate();
    const format = await createTestFormat({ designTemplate: template });
    const item = await createTestProductionItem({ status: "Idea", sourceType: "repurposed", postType: "instagram_post", format: format.name });
    await createTestDesignFrame({ productionItemId: item.id, isPick: true, s3Key: "vitest/pick.jpg" });
    const withPhoto = (src: DesignImageSource): DesignDoc => ({ ...template, pages: template.pages.map((p) => ({ ...p, elements: p.elements.map((e) => (e.type === "image" && e.slot?.kind === "photo" ? { ...e, src } : e)) })) });
    expect(photoSlotSrcs(withPhoto(s3("x")))).toHaveLength(1);
    await createTestDesignDoc({ productionItemId: item.id, doc: withPhoto(s3("vitest/pick.jpg")) });
    await createTestDesignPhoto({ productionItemId: item.id, s3Key: "vitest/founder.jpg" });
    const userId = await getTestUserId();

    await loadDesignEditorSession({ productionItemId: item.id, userId });
    const [row] = await db.select().from(designDocs).where(eq(designDocs.productionItemId, item.id));
    expect(photoSlotSrcs(row.doc as DesignDoc)).toEqual(photoSlotSrcs(withPhoto(s3("vitest/founder.jpg"))));

    // Someone swaps a different picture in by hand → reopening leaves it.
    await db.update(designDocs).set({ doc: withPhoto(s3("vitest/hand-picked.jpg")) }).where(eq(designDocs.id, row.id));
    await loadDesignEditorSession({ productionItemId: item.id, userId });
    const [again] = await db.select().from(designDocs).where(eq(designDocs.productionItemId, item.id));
    expect(photoSlotSrcs(again.doc as DesignDoc)).toEqual(photoSlotSrcs(withPhoto(s3("vitest/hand-picked.jpg"))));
  });
});
