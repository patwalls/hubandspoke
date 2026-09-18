/**
 * Export a design: the queue's "Accept" for this item plus a render job.
 *
 * Mirrors what accepting in the classic triage dialog does
 * (POST /api/production-items/[id]/outcome — status → Assigned, an
 * `accepted` activity event) so the item moves through the workflow the
 * same way, then queues `design-render`, which lands the pages as the item's
 * media slides. The AI's caption goes into the item's current content draft
 * if that field is still empty — never over something a person wrote.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, contentEvents, designDocs, designRenders, productionItems } from "@/lib/db/schema";
import { getSchemaForPostType, type PostType } from "@/lib/platform-field-schemas";
import { enqueue } from "@/jobs/enqueue";
import { recordToolAction } from "@/lib/services/content-events";
import { applyDraftPatch, NoCurrentDraftError } from "@/lib/services/content-drafts/apply-patch";
import { parseDesignDoc } from "@/lib/design-editor/doc";
import type { PlaybookBrief } from "@/lib/design-editor/playbook-template";

export class DesignNotFoundError extends Error {
  constructor() {
    super("No design for this item — open it in the editor first");
    this.name = "DesignNotFoundError";
  }
}

export async function exportDesign(args: {
  productionItemId: string;
  actorUserId: string;
}): Promise<{ renderId: string; productionItemId: string; brand: string; reExport: boolean }> {
  const [design] = await db
    .select({ id: designDocs.id, doc: designDocs.doc, brief: designDocs.brief })
    .from(designDocs)
    .where(eq(designDocs.productionItemId, args.productionItemId))
    .limit(1);
  if (!design) throw new DesignNotFoundError();
  const parsed = parseDesignDoc(design.doc);
  if (!parsed.ok) throw new Error(parsed.error);

  const [item] = await db
    .select({ id: productionItems.id, status: productionItems.status, brand: productionItems.brand, editorUserId: productionItems.editorUserId })
    .from(productionItems)
    .where(eq(productionItems.id, args.productionItemId))
    .limit(1);
  if (!item) throw new DesignNotFoundError();

  const [prior] = await db.select({ id: designRenders.id }).from(designRenders).where(eq(designRenders.designDocId, design.id)).limit(1);
  const reExport = !!prior;

  await db
    .update(designRenders)
    .set({ status: "superseded", finishedAt: new Date() })
    .where(and(eq(designRenders.designDocId, design.id), inArray(designRenders.status, ["queued", "rendering"])));

  const [render] = await db
    .insert(designRenders)
    .values({ designDocId: design.id, productionItemId: item.id, doc: parsed.doc, requestedByUserId: args.actorUserId })
    .returning({ id: designRenders.id });

  if (item.status === "Idea") {
    await db.transaction(async (tx) => {
      await tx
        .update(productionItems)
        .set({ status: "Assigned", editorUserId: item.editorUserId ?? args.actorUserId, updatedAt: new Date() })
        .where(eq(productionItems.id, item.id));
      await tx.insert(contentEvents).values({
        contentItemId: item.id,
        userId: args.actorUserId,
        eventType: "accepted",
        payload: { type: "accepted", from: item.status, reason: "Designed in the in-app design editor" },
      });
    });
  }

  const brief = design.brief as unknown as PlaybookBrief | null;
  if (brief?.caption && !reExport) await seedCaption(item.id, brief.caption, args.actorUserId);

  await recordToolAction({
    contentItemId: item.id,
    userId: args.actorUserId,
    tool: "design-editor",
    action: "render_started",
    status: "info",
    label: reExport ? "Re-exporting the post from the in-app design editor…" : "Exporting the post from the in-app design editor…",
    meta: { renderId: render.id, pages: parsed.doc.pages.length },
  });

  await enqueue(
    "design-render",
    { renderId: render.id },
    { jobKey: `design-render:${design.id}`, jobKeyMode: "replace", queueName: "media-heavy", maxAttempts: 3 },
  );

  return { renderId: render.id, productionItemId: item.id, brand: item.brand ?? "starter-story", reExport };
}

/**
 * Put the AI caption on the post. Normally the item already has a current
 * draft (the Draft Algorithm seeds one when the item is created) and this is
 * an ordinary patch that fills an EMPTY caption — a caption a person already
 * wrote is never overwritten. Right after creation the draft may not exist
 * yet (the algorithm runs on the worker); then this creates version 1 itself
 * rather than racing it, using the platform's field schema so the simulator
 * renders it like any other draft.
 */
async function seedCaption(itemId: string, caption: string, actorUserId: string): Promise<void> {
  const [current] = await db
    .select({ content: contentDrafts.content })
    .from(contentDrafts)
    .where(and(eq(contentDrafts.productionItemId, itemId), eq(contentDrafts.isCurrent, true)))
    .limit(1);
  if (current) {
    const existing = (current.content as { caption?: unknown }).caption;
    if (typeof existing === "string" && existing.trim()) return;
    try {
      await applyDraftPatch({ itemId, validatedPatch: { caption }, actorUserId });
    } catch (err) {
      if (!(err instanceof NoCurrentDraftError)) throw err;
    }
    return;
  }
  const [item] = await db.select({ postType: productionItems.postType }).from(productionItems).where(eq(productionItems.id, itemId)).limit(1);
  const schema = getSchemaForPostType((item?.postType as PostType | null) ?? "instagram_post") ?? getSchemaForPostType("instagram_post")!;
  await db.insert(contentDrafts).values({
    productionItemId: itemId,
    version: 1,
    isCurrent: true,
    content: { caption },
    fieldSchemaSnapshot: schema,
    generatedBy: "design-editor:brief",
    createdByUserId: actorUserId,
  });
}
