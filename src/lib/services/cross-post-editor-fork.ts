/**
 * Carry in-app editor state (design editor / clip editor) across a cross-post.
 *
 * When an item that was designed or clipped in-app is cross-posted, the new
 * cross-post should open the SAME design/clip in the editor — mirroring how the
 * Descript project is carried over — but with fork-on-edit semantics: the
 * cross-post gets its OWN copy of the editor doc + render, so editing (and
 * re-exporting) the cross-post never mutates the post it was cross-posted from.
 *
 * Because `design_docs` / `clip_edits` and their render rows are separate rows
 * keyed to the item (or, for clips, to a clip idea), the fork is just a row
 * copy: the source and the cross-post hold independent documents. There is no
 * runtime "don't touch the source" guard — the isolation is structural.
 *
 * Both entry points (DesignRenderStatusPill / ClipRenderStatusPill) are
 * render-gated: the "Edit design/clip & re-export" affordance only appears when
 * a render row exists. So we copy the source's latest DONE render too, pointing
 * it at the same S3 output (no re-render, no extra cost) — the pill lights up
 * immediately and the editor opens from the source's design/clip.
 *
 * Best-effort and additive: callers run this in its own transaction after the
 * cross-post is created, so a failure here never blocks the cross-post itself.
 */
import { and, desc, eq } from "drizzle-orm";
import type { db as dbClient } from "@/lib/db";
import {
  clipEdits,
  clipIdeas,
  clipRenders,
  designDocs,
  designRenders,
  productionItems,
} from "@/lib/db/schema";

/** A transaction handle (the arg drizzle hands the `db.transaction` callback). */
type Tx = Parameters<Parameters<typeof dbClient.transaction>[0]>[0];

/** Deep-copy a JSONB value so the fork holds its own object, not a shared ref. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface ForkEditorStateArgs {
  /** The item being cross-posted FROM (its editor state is the source). */
  sourceId: string;
  /** The freshly-created cross-post item that should receive the fork. */
  crossPostId: string;
  /** Who triggered the cross-post — recorded as the fork's creator/requester. */
  userId: string;
}

/**
 * Copy the source item's design-editor and/or clip-editor state onto the
 * cross-post. No-op for either editor the source never used (or whose latest
 * render isn't `done`). Runs entirely on the passed transaction.
 */
export async function forkEditorStateForCrossPost(
  tx: Tx,
  { sourceId, crossPostId, userId }: ForkEditorStateArgs,
): Promise<void> {
  await forkDesign(tx, { sourceId, crossPostId, userId });
  await forkClip(tx, { sourceId, crossPostId, userId });
}

async function forkDesign(tx: Tx, { sourceId, crossPostId, userId }: ForkEditorStateArgs): Promise<void> {
  const [srcDoc] = await tx
    .select({ doc: designDocs.doc, brief: designDocs.brief, briefInstruction: designDocs.briefInstruction })
    .from(designDocs)
    .where(eq(designDocs.productionItemId, sourceId))
    .limit(1);
  if (!srcDoc) return;

  // Only carry over a design that actually rendered — the editor entry point is
  // render-gated, and a half-drafted design isn't something to hand an editor.
  const [srcRender] = await tx
    .select()
    .from(designRenders)
    .where(and(eq(designRenders.productionItemId, sourceId), eq(designRenders.status, "done")))
    .orderBy(desc(designRenders.createdAt))
    .limit(1);
  if (!srcRender) return;

  const [newDoc] = await tx
    .insert(designDocs)
    .values({
      productionItemId: crossPostId,
      doc: clone(srcDoc.doc),
      brief: srcDoc.brief ? clone(srcDoc.brief) : null,
      briefInstruction: srcDoc.briefInstruction,
      createdByUserId: userId,
    })
    // A cross-post is a new item, so there's no existing design_doc for it; the
    // guard just keeps a double-fork race from 500ing.
    .onConflictDoNothing({ target: designDocs.productionItemId })
    .returning({ id: designDocs.id });
  if (!newDoc) return;

  await tx.insert(designRenders).values({
    designDocId: newDoc.id,
    productionItemId: crossPostId,
    doc: clone(srcRender.doc),
    status: "done",
    progress: 100,
    // Same rendered slides (same S3 keys) — the cross-post shows the source's
    // design until someone edits + re-exports it into its own render.
    outputKeys: srcRender.outputKeys ? clone(srcRender.outputKeys) : null,
    renderSeconds: srcRender.renderSeconds,
    requestedByUserId: userId,
    startedAt: srcRender.startedAt,
    finishedAt: srcRender.finishedAt ?? new Date(),
  });
}

async function forkClip(tx: Tx, { sourceId, crossPostId, userId }: ForkEditorStateArgs): Promise<void> {
  // The clip editor keys on a clip idea, not on a production item, so the
  // source's clip is reachable via its latest render:
  //   clip_renders(productionItemId = source) → clip_edits → clip_ideas.
  const [src] = await tx
    .select({
      idea: clipIdeas,
      editDoc: clipEdits.doc,
      renderDoc: clipRenders.doc,
      outputS3Bucket: clipRenders.outputS3Bucket,
      outputS3Key: clipRenders.outputS3Key,
      outputSizeBytes: clipRenders.outputSizeBytes,
      durationSec: clipRenders.durationSec,
      renderSeconds: clipRenders.renderSeconds,
      startedAt: clipRenders.startedAt,
      finishedAt: clipRenders.finishedAt,
    })
    .from(clipRenders)
    .innerJoin(clipEdits, eq(clipEdits.id, clipRenders.clipEditId))
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .where(and(eq(clipRenders.productionItemId, sourceId), eq(clipRenders.status, "done")))
    .orderBy(desc(clipRenders.createdAt))
    .limit(1);
  if (!src) return;

  // Fork a clip idea for the cross-post. It keeps the clip editor's
  // clipIdeaId-keyed contract intact (vs. re-keying clip_edits per item) and
  // gives the cross-post an independent idea → edit → render chain. It lands
  // "assigned" (already accepted to this cross-post), exactly like a promoted
  // idea, so triage/routing (which only touches "suggested") leaves it alone.
  const [newIdea] = await tx
    .insert(clipIdeas)
    .values({
      sourceProductionItemId: src.idea.sourceProductionItemId,
      batchId: src.idea.batchId,
      targetFormat: src.idea.targetFormat,
      startSec: src.idea.startSec,
      endSec: src.idea.endSec,
      hookSegments: src.idea.hookSegments ? clone(src.idea.hookSegments) : null,
      hook: src.idea.hook,
      angle: src.idea.angle,
      rationale: src.idea.rationale,
      generatedBy: "service:cross-post-fork",
      status: "assigned",
      acceptedProductionItemId: crossPostId,
      acceptedTargetFormat: src.idea.acceptedTargetFormat,
      decidedAt: new Date(),
      decidedByUserId: userId,
    })
    .returning({ id: clipIdeas.id });
  if (!newIdea) return;

  const [newEdit] = await tx
    .insert(clipEdits)
    .values({
      clipIdeaId: newIdea.id,
      doc: clone(src.editDoc),
      createdByUserId: userId,
    })
    .returning({ id: clipEdits.id });
  if (!newEdit) return;

  await tx.insert(clipRenders).values({
    clipEditId: newEdit.id,
    productionItemId: crossPostId,
    doc: clone(src.renderDoc),
    status: "done",
    progress: 100,
    // Same rendered mp4 (same S3 object) until the cross-post is re-exported.
    outputS3Bucket: src.outputS3Bucket,
    outputS3Key: src.outputS3Key,
    outputSizeBytes: src.outputSizeBytes,
    durationSec: src.durationSec,
    renderSeconds: src.renderSeconds,
    requestedByUserId: userId,
    startedAt: src.startedAt,
    finishedAt: src.finishedAt ?? new Date(),
  });

  // Point the cross-post at its own forked idea for lineage (mirrors how a
  // promoted clip carries sourceClipIdeaId).
  await tx
    .update(productionItems)
    .set({ sourceClipIdeaId: newIdea.id })
    .where(eq(productionItems.id, crossPostId));
}
