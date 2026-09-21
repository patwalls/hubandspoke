/**
 * The post that goes with a clip.
 *
 * Every clip idea has a queue-side production item from the moment it is
 * generated (clip-idea-generate.ts writes it with status "Idea"), so the
 * Draft Algorithm can write the post copy long before the clip is exported.
 * Until 2026-09-21 it only ran after export; now `ensureClipPostDraft` runs
 * when the in-app editor opens, and the editor's Post tab shows the result
 * next to the video. Export still enqueues the algorithm as a safety net —
 * its `already_filled` guard makes that a no-op once a draft exists.
 *
 * `loadClipCut` is the algorithm's view of the clip: the words that survive
 * the current edit (see draft-agent.ts, THE CLIP).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, contentDrafts, productionItems, transcripts } from "@/lib/db/schema";
import { PLATFORM_FIELD_MAP, type PostType } from "@/lib/platform-field-schemas";
import { clipCutFromDoc, clipCutFromRange, type ClipCut } from "@/lib/clip-editor/clip-cut";
import { parseDoc } from "@/lib/clip-editor/doc";
import { resolveTranscriptWords } from "@/lib/clip-editor/words";
import { enqueue } from "@/jobs/enqueue";

export type ClipPostState =
  /** The item has a written post. */
  | "ready"
  /** A `draft-algorithm-run` job is queued for it. */
  | "drafting"
  /** No queue-side item — nothing to draft into (legacy ideas only). */
  | "unavailable";

export interface ClipPost {
  productionItemId: string;
  postType: string | null;
  state: ClipPostState;
}

/**
 * Make sure the clip's post is written or being written. Idempotent: a
 * post with a caption is left alone (so a human edit is never re-drafted
 * from here — that is the Post tab's explicit Redraft), and the job key
 * folds repeat opens into the run already in the queue (a run that is
 * mid-flight is re-run once afterwards, where the algorithm's own guard
 * makes it a no-op; a run that failed for good is retried).
 */
export async function ensureClipPostDraft(clipIdeaId: string): Promise<ClipPost | null> {
  const [item] = await db
    .select({ id: productionItems.id, postType: productionItems.postType })
    .from(productionItems)
    .where(eq(productionItems.sourceClipIdeaId, clipIdeaId))
    .limit(1);
  if (!item) return null;
  if (await hasWrittenPost(item.id, item.postType)) {
    return { productionItemId: item.id, postType: item.postType, state: "ready" };
  }
  try {
    await enqueue(
      "draft-algorithm-run",
      { productionItemId: item.id },
      { jobKey: `draft-algorithm-run:${item.id}` },
    );
  } catch (err) {
    console.error("draft-algorithm-run enqueue (clip editor open) failed:", err);
  }
  return { productionItemId: item.id, postType: item.postType, state: "drafting" };
}

async function hasWrittenPost(productionItemId: string, postType: string | null): Promise<boolean> {
  const [draft] = await db
    .select({ content: contentDrafts.content })
    .from(contentDrafts)
    .where(and(eq(contentDrafts.productionItemId, productionItemId), eq(contentDrafts.isCurrent, true)))
    .limit(1);
  if (!draft) return false;
  const captionKey = postType ? PLATFORM_FIELD_MAP[postType as PostType]?.caption : null;
  if (!captionKey) return true; // a draft exists and there is no caption slot to fill
  const caption = (draft.content as Record<string, unknown> | null)?.[captionKey];
  return typeof caption === "string" && caption.trim().length > 0;
}

/**
 * What the clip says: the kept words of its edit when the in-app editor has
 * one, else the idea's proposed range. Null when the source has no
 * transcript to read from.
 */
export async function loadClipCut(clipIdeaId: string): Promise<ClipCut | null> {
  const [idea] = await db
    .select({
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      editDoc: clipEdits.doc,
    })
    .from(clipIdeas)
    .leftJoin(clipEdits, eq(clipEdits.clipIdeaId, clipIdeas.id))
    .where(eq(clipIdeas.id, clipIdeaId))
    .limit(1);
  if (!idea) return null;
  const [transcript] = await db
    .select({ words: transcripts.words, segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, idea.sourceProductionItemId))
    .limit(1);
  if (!transcript || transcript.segments.length === 0) return null;
  const { words } = resolveTranscriptWords(transcript);
  if (idea.editDoc) {
    const parsed = parseDoc(idea.editDoc);
    if (parsed.ok) {
      const cut = clipCutFromDoc(parsed.doc, words);
      if (cut) return cut;
    }
  }
  return clipCutFromRange({ startSec: Number(idea.startSec), endSec: Number(idea.endSec) }, words);
}
