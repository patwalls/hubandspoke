import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas } from "@/lib/db/schema";
import { findHookLayer, type ClipEditDoc } from "@/lib/clip-editor/doc";

export type SaveClipEditResult =
  | { ok: true; revision: number }
  /** Someone (another tab) saved first. The client must reload, not retry. */
  | { ok: false; reason: "conflict"; currentRevision: number }
  | { ok: false; reason: "not_found" };

/**
 * Persist an edit document with optimistic concurrency: the UPDATE only
 * lands if the row is still at the revision the client loaded.
 *
 * Also mirrors the hook text back onto the clip idea while it is still
 * undecided, so the queue row and the classic dialog show the hook the
 * editor actually wrote. Once the idea is promoted the production item owns
 * the hook and the idea is left alone.
 */
export async function saveClipEdit(args: {
  clipIdeaId: string;
  expectedRevision: number;
  doc: ClipEditDoc;
}): Promise<SaveClipEditResult> {
  const [updated] = await db
    .update(clipEdits)
    .set({
      doc: args.doc,
      revision: sql`${clipEdits.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(clipEdits.clipIdeaId, args.clipIdeaId),
        eq(clipEdits.revision, args.expectedRevision),
      ),
    )
    .returning({ revision: clipEdits.revision });

  if (!updated) {
    const [current] = await db
      .select({ revision: clipEdits.revision })
      .from(clipEdits)
      .where(eq(clipEdits.clipIdeaId, args.clipIdeaId))
      .limit(1);
    return current
      ? { ok: false, reason: "conflict", currentRevision: current.revision }
      : { ok: false, reason: "not_found" };
  }

  const hook = findHookLayer(args.doc)?.text.trim();
  if (hook) {
    await db
      .update(clipIdeas)
      .set({ hook })
      .where(
        and(eq(clipIdeas.id, args.clipIdeaId), eq(clipIdeas.status, "suggested")),
      );
  }
  return { ok: true, revision: updated.revision };
}
