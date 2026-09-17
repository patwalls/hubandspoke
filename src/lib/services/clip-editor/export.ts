/**
 * Export a clip edit — the in-app replacement for "Create in Descript".
 *
 * Does the same workflow bookkeeping the Descript promotion paths do
 * (src/lib/services/promote-clip-idea.ts), so a clip made here is
 * indistinguishable downstream: the queue-side production item flips to
 * Assigned with the editor on it, the idea is marked assigned, the promotion
 * comment and activity events are written, and the Draft Algorithm drafts the
 * post copy. The ONLY difference is what produces the video — a `clip-render`
 * job on our own worker instead of a Descript project.
 *
 * Re-export is supported: exporting an idea this editor already promoted
 * queues a new render (superseding any in flight) and skips the one-time
 * promotion side effects.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipEdits,
  clipIdeas,
  clipRenders,
  contentComments,
  productionItems,
} from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { recordToolAction } from "@/lib/services/content-events";
import {
  ClipIdeaAlreadyDecidedError,
  ClipIdeaSourceMissingMediaError,
  buildContentBody,
  loadAndGuardClipIdea,
  loadClipProductionItemId,
} from "@/lib/services/promote-clip-idea";
import { findHookLayer, parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { compileRenderPlan } from "@/lib/clip-editor/plan";

export class ClipEditNotFoundError extends Error {
  constructor() {
    super("No saved edit for this clip idea — open it in the editor first");
    this.name = "ClipEditNotFoundError";
  }
}

export class ClipEditEmptyError extends Error {
  constructor() {
    super("This edit removes all footage — restore something before exporting");
    this.name = "ClipEditEmptyError";
  }
}

export interface ExportClipEditResult {
  renderId: string;
  productionItemId: string;
  brand: string;
  reExport: boolean;
}

export async function exportClipEdit(args: {
  clipIdeaId: string;
  actorUserId: string;
}): Promise<ExportClipEditResult> {
  const [edit] = await db
    .select({ id: clipEdits.id, doc: clipEdits.doc })
    .from(clipEdits)
    .where(eq(clipEdits.clipIdeaId, args.clipIdeaId))
    .limit(1);
  if (!edit) throw new ClipEditNotFoundError();
  const parsed = parseDoc(edit.doc);
  if (!parsed.ok) throw new Error(parsed.error);
  const doc = parsed.doc;
  // Timeline-only check (no words needed): refuse before any side effects.
  if (compileRenderPlan(doc, []).totalFrames === 0) throw new ClipEditEmptyError();

  const row = await loadAndGuardClipIdea(args.clipIdeaId, { allowDecided: true });
  if (!row.mediaS3Key) throw new ClipIdeaSourceMissingMediaError();
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  // A decided idea is only re-exportable if THIS editor decided it. An idea
  // that was killed, or promoted through Descript, stays closed.
  const [priorRender] = await db
    .select({ id: clipRenders.id })
    .from(clipRenders)
    .where(eq(clipRenders.clipEditId, edit.id))
    .limit(1);
  const reExport = row.status !== "suggested";
  if (reExport && (row.status !== "assigned" || !priorRender)) {
    throw new ClipIdeaAlreadyDecidedError(row.status);
  }

  const brand = row.sourceBrand ?? "starter-story";
  const hook = findHookLayer(doc)?.text.trim() || row.hook;

  // Anything still queued/rendering for this edit is now stale.
  await db
    .update(clipRenders)
    .set({ status: "superseded", finishedAt: new Date() })
    .where(
      and(
        eq(clipRenders.clipEditId, edit.id),
        inArray(clipRenders.status, ["queued", "rendering"]),
      ),
    );

  const [render] = await db
    .insert(clipRenders)
    .values({
      clipEditId: edit.id,
      productionItemId,
      doc,
      requestedByUserId: args.actorUserId,
    })
    .returning({ id: clipRenders.id });

  if (!reExport) {
    await db
      .update(productionItems)
      .set({
        status: "Assigned",
        title: hook,
        hook,
        contentBody: buildContentBody({ ...row, hook }),
        editorUserId: args.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, productionItemId));
  } else {
    await db
      .update(productionItems)
      .set({ title: hook, hook, updatedAt: new Date() })
      .where(eq(productionItems.id, productionItemId));
  }

  await recordToolAction({
    contentItemId: productionItemId,
    userId: args.actorUserId,
    tool: "clip-editor",
    action: "render_started",
    status: "info",
    label: reExport
      ? "Re-exporting the clip from the in-app editor…"
      : "Exporting the clip from the in-app editor…",
    meta: { renderId: render.id },
  });

  await enqueue(
    "clip-render",
    { renderId: render.id },
    {
      // One pending render per edit; `media-heavy` serializes it behind any
      // other ffmpeg work — two concurrent encodes R15 the Basic worker dyno.
      jobKey: `clip-render:${edit.id}`,
      jobKeyMode: "replace",
      queueName: "media-heavy",
      maxAttempts: 3,
    },
  );

  if (!reExport) {
    await db
      .update(clipIdeas)
      .set({
        status: "assigned",
        hook,
        acceptedEditorUserId: args.actorUserId,
        acceptedProductionItemId: productionItemId,
        decidedAt: new Date(),
        decidedByUserId: args.actorUserId,
      })
      .where(eq(clipIdeas.id, args.clipIdeaId));

    await postClipCreatedComment({
      productionItemId,
      actorUserId: args.actorUserId,
      doc,
      hook,
    });

    // Same fire-and-forget the Descript paths do: drafts the post copy from
    // the pillar transcript + format Skill, independent of the video bytes.
    try {
      await enqueue("draft-algorithm-run", { productionItemId });
    } catch (err) {
      console.error("draft-algorithm-run enqueue (clip-editor export) failed:", err);
    }
  }

  return { renderId: render.id, productionItemId, brand, reExport };
}

function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The activity-feed comment body for a clip made in the editor. Exported
 *  for the test; the feed prefixes the author's name, so this reads as
 *  "Pat Walls: Created a clip from the queue · 04:22–05:07 (40s)". */
export function buildClipCreatedComment(doc: ClipEditDoc, hook: string): string {
  const startSec = Math.min(...doc.sections.map((s) => s.startSec));
  const endSec = Math.max(...doc.sections.map((s) => s.endSec));
  // What actually plays, after cuts — not the span it was taken from.
  const durationSec = Math.round(compileRenderPlan(doc, []).durationSec);
  return [
    `<p>Created a clip from the queue · <strong>${mmss(startSec)}–${mmss(endSec)}</strong> (${durationSec}s)</p>`,
    `<blockquote>${escapeHtml(hook)}</blockquote>`,
  ].join("\n");
}

/**
 * Deliberately terse compared with the Descript paths' promotion comment
 * (which pastes the rationale and the whole transcript excerpt for an editor
 * who is about to go cut the clip in another tool). Here the clip is already
 * cut — range + hook is the whole story. Best-effort: a failed comment must
 * never fail an export.
 */
async function postClipCreatedComment(args: {
  productionItemId: string;
  actorUserId: string;
  doc: ClipEditDoc;
  hook: string;
}): Promise<void> {
  try {
    await db.insert(contentComments).values({
      contentItemId: args.productionItemId,
      userId: args.actorUserId,
      body: buildClipCreatedComment(args.doc, args.hook),
    });
  } catch (err) {
    console.error("clip-editor export: activity comment failed:", err);
  }
}
