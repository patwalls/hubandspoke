/**
 * Review notes ↔ the clip editor (review-notes M3 + M4).
 *
 * People leave notes pinned to a moment of the clip's video on the content
 * page (`content_comments.at_seconds`). The editor shows the open ones on
 * its timeline (M3), and a finished re-render marks every note left before
 * it was requested done (M4): the new cut is a new video, so a note on the
 * old one is settled — and anyone can Reopen it from the content page.
 */
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipRenders, contentComments, productionItems, users } from "@/lib/db/schema";
import { parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";

export interface EditorReviewNote {
  id: string;
  /** Seconds into the video the note was left on (the rendered clip). */
  atSeconds: number;
  body: string;
  authorName: string | null;
  createdAt: string;
}

export interface EditorReviewNotes {
  notes: EditorReviewNote[];
  /** The doc of the render that is the item's video right now — what the
   *  notes' times are on. Null when the video isn't an editor render. */
  renderedDoc: ClipEditDoc | null;
}

/** Open timecoded notes on the clip's post, oldest moment first. */
export async function loadEditorReviewNotes(productionItemId: string): Promise<EditorReviewNotes> {
  const notes = await db
    .select({
      id: contentComments.id,
      atSeconds: contentComments.atSeconds,
      body: contentComments.body,
      userName: users.name,
      authorName: contentComments.authorName,
      createdAt: contentComments.createdAt,
    })
    .from(contentComments)
    .leftJoin(users, eq(users.id, contentComments.userId))
    .where(
      and(
        eq(contentComments.contentItemId, productionItemId),
        isNotNull(contentComments.atSeconds),
        isNull(contentComments.resolvedAt),
      ),
    )
    .orderBy(contentComments.atSeconds);

  let renderedDoc: ClipEditDoc | null = null;
  if (notes.length > 0) {
    const [render] = await db
      .select({ doc: clipRenders.doc })
      .from(clipRenders)
      .innerJoin(productionItems, eq(productionItems.id, clipRenders.productionItemId))
      .where(
        and(
          eq(clipRenders.productionItemId, productionItemId),
          eq(clipRenders.status, "done"),
          // Still the post's video (not replaced by an upload since).
          eq(clipRenders.outputS3Key, productionItems.mediaS3Key),
        ),
      )
      .orderBy(desc(clipRenders.createdAt))
      .limit(1);
    const parsed = render ? parseDoc(render.doc) : null;
    renderedDoc = parsed?.ok ? parsed.doc : null;
  }

  return {
    notes: notes.map((n) => ({
      id: n.id,
      atSeconds: n.atSeconds!,
      body: n.body,
      authorName: n.userName ?? n.authorName,
      createdAt: n.createdAt.toISOString(),
    })),
    renderedDoc,
  };
}

/**
 * Mark done every open timecoded note on the render's item that was left
 * before the render was requested. Notes written while it rendered are
 * about the old cut too, but nobody exported with them in view — they stay
 * open. Idempotent: a retried task finds nothing left to close.
 */
export async function closeNotesSettledByRender(renderId: string): Promise<number> {
  const [render] = await db
    .select({
      productionItemId: clipRenders.productionItemId,
      createdAt: clipRenders.createdAt,
      requestedByUserId: clipRenders.requestedByUserId,
    })
    .from(clipRenders)
    .where(eq(clipRenders.id, renderId))
    .limit(1);
  if (!render) return 0;

  const closed = await db
    .update(contentComments)
    .set({
      resolvedAt: new Date(),
      resolvedByUserId: render.requestedByUserId,
      resolvedByRenderId: renderId,
    })
    .where(
      and(
        eq(contentComments.contentItemId, render.productionItemId),
        isNotNull(contentComments.atSeconds),
        isNull(contentComments.resolvedAt),
        lt(contentComments.createdAt, render.createdAt),
      ),
    )
    .returning({ id: contentComments.id });
  return closed.length;
}
