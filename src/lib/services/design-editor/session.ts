/**
 * Design editor session — everything the editor needs to open on one
 * production item. On first open there is no document yet: the AI writes a
 * brief from the source transcript and the template builds the first draft.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designDocs, designRenders, productionItems } from "@/lib/db/schema";
import { parseDesignDoc, type DesignDoc } from "@/lib/design-editor/doc";
import { buildPlaybookDoc, type PlaybookBrief } from "@/lib/design-editor/playbook-template";
import { generatePlaybookBrief } from "./brief";
import { BRAND_WORDMARKS, previewUrlFor, sourceImageCandidates, type ImageCandidate } from "./assets";
import { toDesignRenderStatus, type DesignRenderStatus } from "./render-status";

import { DESIGN_TEMPLATES } from "@/lib/design-editor/templates";

export class DesignItemNotFoundError extends Error {
  constructor() {
    super("Item not found");
    this.name = "DesignItemNotFoundError";
  }
}

export class DesignUnsupportedError extends Error {
  constructor(public readonly reason: "no_template" | "no_transcript" | "ai_failed", detail?: string) {
    super(
      reason === "no_template"
        ? "This format has no design template yet"
        : reason === "no_transcript"
          ? "The source video has no transcript yet"
          : `The AI couldn't draft this post${detail ? `: ${detail}` : ""}`,
    );
    this.name = "DesignUnsupportedError";
  }
}

export interface DesignEditorSession {
  item: {
    id: string;
    title: string | null;
    brand: string;
    format: string | null;
    status: string | null;
    postType: string | null;
    sourceItemId: string;
    sourceTitle: string | null;
  };
  design: { id: string; revision: number; doc: DesignDoc; brief: PlaybookBrief | null; briefInstruction: string | null };
  /** Element id → URL the browser can load, for every image in the doc. */
  imageUrls: Record<string, string>;
  /** Pictures available to place. */
  images: ImageCandidate[];
  latestRender: DesignRenderStatus | null;
}

export async function loadDesignEditorSession(args: {
  productionItemId: string;
  userId: string;
}): Promise<DesignEditorSession> {
  const item = await loadItem(args.productionItemId);
  const template = item.format ? DESIGN_TEMPLATES[item.format] : undefined;
  if (!template) throw new DesignUnsupportedError("no_template");

  let design = await selectDesign(item.id);
  if (!design) {
    const draft = await draftDoc(item.id, item.sourceItemId, null);
    await db
      .insert(designDocs)
      .values({ productionItemId: item.id, doc: draft.doc, brief: draft.brief as unknown as Record<string, unknown>, createdByUserId: args.userId })
      .onConflictDoNothing({ target: designDocs.productionItemId });
    design = await selectDesign(item.id);
    if (!design) throw new Error("Failed to create design");
  }

  return finishSession(item, design);
}

export async function regenerateDesign(args: {
  productionItemId: string;
  instruction: string | null;
  userId: string;
}): Promise<DesignEditorSession> {
  const item = await loadItem(args.productionItemId);
  if (!item.format || !DESIGN_TEMPLATES[item.format]) throw new DesignUnsupportedError("no_template");
  const draft = await draftDoc(item.id, item.sourceItemId, args.instruction);
  await db
    .insert(designDocs)
    .values({ productionItemId: item.id, doc: draft.doc, brief: draft.brief as unknown as Record<string, unknown>, briefInstruction: args.instruction, createdByUserId: args.userId })
    .onConflictDoUpdate({
      target: designDocs.productionItemId,
      set: {
        doc: draft.doc,
        brief: draft.brief as unknown as Record<string, unknown>,
        briefInstruction: args.instruction,
        // A regeneration replaces the doc wholesale → new revision, so an
        // editor still holding the old one gets a conflict, not a clobber.
        revision: sql`${designDocs.revision} + 1`,
        updatedAt: new Date(),
      },
    });
  const design = await selectDesign(item.id);
  if (!design) throw new Error("Design vanished");
  return finishSession(item, design);
}

async function draftDoc(itemId: string, sourceItemId: string, instruction: string | null) {
  const result = await generatePlaybookBrief({ productionItemId: itemId, instruction });
  if (!result.ok) {
    if (result.failure.reason === "no-transcript") throw new DesignUnsupportedError("no_transcript");
    throw new DesignUnsupportedError("ai_failed", result.failure.message ?? result.failure.reason);
  }
  const images = await sourceImageCandidates(sourceItemId);
  return { brief: result.brief, doc: buildPlaybookDoc(result.brief, images[0]?.src ?? null) };
}

async function loadItem(id: string) {
  const [row] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      format: productionItems.format,
      status: productionItems.status,
      postType: productionItems.postType,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!row) throw new DesignItemNotFoundError();
  const sourceItemId = row.pillarContentItemId ?? row.id;
  const [source] = await db.select({ title: productionItems.title }).from(productionItems).where(eq(productionItems.id, sourceItemId)).limit(1);
  return {
    id: row.id,
    title: row.title,
    brand: row.brand ?? "starter-story",
    format: row.format,
    status: row.status,
    postType: row.postType,
    sourceItemId,
    sourceTitle: source?.title ?? null,
  };
}

async function selectDesign(productionItemId: string) {
  const [row] = await db
    .select({ id: designDocs.id, revision: designDocs.revision, doc: designDocs.doc, brief: designDocs.brief, briefInstruction: designDocs.briefInstruction })
    .from(designDocs)
    .where(eq(designDocs.productionItemId, productionItemId))
    .limit(1);
  if (!row) return null;
  const parsed = parseDesignDoc(row.doc);
  if (!parsed.ok) throw new Error(`Stored design ${row.id} is invalid: ${parsed.error}`);
  return { id: row.id, revision: row.revision, doc: parsed.doc, brief: (row.brief as unknown as PlaybookBrief | null) ?? null, briefInstruction: row.briefInstruction };
}

async function finishSession(item: Awaited<ReturnType<typeof loadItem>>, design: NonNullable<Awaited<ReturnType<typeof selectDesign>>>): Promise<DesignEditorSession> {
  const imageUrls = await resolveImageUrls(design.doc);
  const [render] = await db.select().from(designRenders).where(eq(designRenders.designDocId, design.id)).orderBy(desc(designRenders.createdAt)).limit(1);
  return {
    item,
    design,
    imageUrls,
    images: [...(await sourceImageCandidates(item.sourceItemId)), ...BRAND_WORDMARKS],
    latestRender: render ? toDesignRenderStatus(render) : null,
  };
}

export async function resolveImageUrls(doc: DesignDoc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const page of doc.pages) {
    for (const el of page.elements) {
      if (el.type === "image") out[el.id] = await previewUrlFor(el.src);
    }
  }
  return out;
}
