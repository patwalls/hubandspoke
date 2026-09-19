/**
 * Editor session — everything the clip editor needs to open on one clip
 * idea, in one round trip: the idea, its (lazily created) edit document, a
 * playable source URL, and the transcript words around the clip.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipEdits,
  clipIdeas,
  clipRenders,
  formats,
  productionItems,
  transcripts,
} from "@/lib/db/schema";
import { resolveClipAspectRatio } from "@/lib/db/formats";
import { getPresignedGetUrl } from "@/lib/s3";
import { applyLook, clipLookSchema, createDefaultDoc, parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { resolveTranscriptWords, type EditorWord } from "@/lib/clip-editor/words";
import type { TranscriptSpeaker } from "@/lib/diarization/types";
import { toRenderStatus, type ClipRenderStatus } from "./render-status";

export class ClipEditorIdeaNotFoundError extends Error {
  constructor() {
    super("Clip idea not found");
    this.name = "ClipEditorIdeaNotFoundError";
  }
}

/** The editor needs a playable video AND a transcript; anything else falls
 *  back to the classic triage dialog. */
export class ClipEditorUnsupportedSourceError extends Error {
  constructor(
    public readonly reason:
      | "no_media"
      | "audio_only"
      | "no_transcript"
      | "already_decided",
  ) {
    super(
      reason === "already_decided"
        ? "This idea was already decided outside the editor"
        : reason === "no_media"
        ? "The source has no archived media yet"
        : reason === "audio_only"
          ? "The source is audio-only — the editor needs video"
          : "The source has no transcript yet",
    );
    this.name = "ClipEditorUnsupportedSourceError";
  }
}

export interface ClipEditorSession {
  clipIdea: {
    id: string;
    status: string;
    hook: string;
    angle: string;
    rationale: string;
    startSec: number;
    endSec: number;
    targetFormat: string | null;
    acceptedProductionItemId: string | null;
  };
  brand: string;
  edit: { id: string; revision: number; doc: ClipEditDoc };
  source: {
    productionItemId: string;
    title: string | null;
    videoUrl: string;
    durationSec: number | null;
  };
  /** Every word of the source transcript, in order. */
  words: EditorWord[];
  /** Detected speakers (null until speaker detection has run). */
  speakers: TranscriptSpeaker[] | null;
  /** True when word timings were interpolated from caption segments. */
  wordsSynthetic: boolean;
  latestRender: ClipRenderStatus | null;
}

export async function loadClipEditorSession(args: {
  clipIdeaId: string;
  userId: string;
}): Promise<ClipEditorSession> {
  const [row] = await db
    .select({
      id: clipIdeas.id,
      status: clipIdeas.status,
      hook: clipIdeas.hook,
      angle: clipIdeas.angle,
      rationale: clipIdeas.rationale,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      hookSegments: clipIdeas.hookSegments,
      targetFormat: clipIdeas.targetFormat,
      acceptedProductionItemId: clipIdeas.acceptedProductionItemId,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      sourceTitle: productionItems.title,
      sourceBrand: productionItems.brand,
      mediaS3Key: productionItems.mediaS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
      mediaContentType: productionItems.mediaContentType,
    })
    .from(clipIdeas)
    .leftJoin(
      productionItems,
      eq(productionItems.id, clipIdeas.sourceProductionItemId),
    )
    .where(eq(clipIdeas.id, args.clipIdeaId))
    .limit(1);
  if (!row) throw new ClipEditorIdeaNotFoundError();
  if (!row.mediaS3Key) throw new ClipEditorUnsupportedSourceError("no_media");
  if (row.mediaContentType?.startsWith("audio/")) {
    throw new ClipEditorUnsupportedSourceError("audio_only");
  }

  const [transcript] = await db
    .select({
      words: transcripts.words,
      segments: transcripts.segments,
      durationSec: transcripts.durationSec,
      speakers: transcripts.speakers,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, row.sourceProductionItemId))
    .limit(1);
  if (!transcript || transcript.segments.length === 0) {
    throw new ClipEditorUnsupportedSourceError("no_transcript");
  }

  const brand = row.sourceBrand ?? "starter-story";
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);

  // An idea that was killed or promoted through Descript has no business
  // getting an edit doc; only ideas this editor exported stay openable
  // (for re-export). Checked BEFORE the lazy create below.
  if (row.status !== "suggested" && !(await selectEdit(row.id))) {
    throw new ClipEditorUnsupportedSourceError("already_decided");
  }

  const edit = await loadOrCreateEdit({
    clipIdeaId: row.id,
    userId: args.userId,
    makeDefault: async () => {
      const format = await loadTargetFormat(brand, row.targetFormat);
      const doc = createDefaultDoc({
        startSec,
        endSec,
        hook: row.hook,
        aspectRatio: format ? resolveClipAspectRatio(format) : "9:16",
        introRanges: row.hookSegments ?? [],
      });
      // The format's saved look (fonts, caption style, video inset) is the
      // starting point for every new edit of that format.
      const look = format?.clipTemplate ? clipLookSchema.safeParse(format.clipTemplate) : null;
      return look?.success ? applyLook(doc, look.data) : doc;
    },
  });

  // The WHOLE transcript: the editor shows the full source so any part of it
  // can be edited into the clip. (~60 bytes/word — an hour-long podcast is
  // well under 1 MB before gzip.)
  const { words, synthetic } = resolveTranscriptWords(transcript);

  const videoUrl = await getPresignedGetUrl(row.mediaS3Key, 4 * 3600, {
    bucket: row.mediaS3Bucket ?? undefined,
  });

  const [render] = await db
    .select()
    .from(clipRenders)
    .where(eq(clipRenders.clipEditId, edit.id))
    .orderBy(desc(clipRenders.createdAt))
    .limit(1);

  return {
    clipIdea: {
      id: row.id,
      status: row.status,
      hook: row.hook,
      angle: row.angle,
      rationale: row.rationale,
      startSec,
      endSec,
      targetFormat: row.targetFormat,
      acceptedProductionItemId: row.acceptedProductionItemId,
    },
    brand,
    edit,
    source: {
      productionItemId: row.sourceProductionItemId,
      title: row.sourceTitle,
      videoUrl,
      durationSec: transcript.durationSec ? Number(transcript.durationSec) : null,
    },
    words,
    speakers: transcript.speakers ?? null,
    wordsSynthetic: synthetic,
    latestRender: render ? toRenderStatus(render) : null,
  };
}

async function loadTargetFormat(brand: string, targetFormat: string | null) {
  if (!targetFormat) return null;
  const [format] = await db
    .select({
      clipAspectRatio: formats.clipAspectRatio,
      clipTargetPostType: formats.clipTargetPostType,
      clipTemplate: formats.clipTemplate,
    })
    .from(formats)
    .where(and(eq(formats.brand, brand), eq(formats.name, targetFormat)))
    .limit(1);
  return format ?? null;
}

async function loadOrCreateEdit(args: {
  clipIdeaId: string;
  userId: string;
  makeDefault: () => Promise<ClipEditDoc>;
}): Promise<{ id: string; revision: number; doc: ClipEditDoc }> {
  const existing = await selectEdit(args.clipIdeaId);
  if (existing) return existing;
  // ON CONFLICT DO NOTHING: two tabs opening the same idea at once must not
  // race into a unique-violation 500 — the loser just reads the winner's row.
  await db
    .insert(clipEdits)
    .values({
      clipIdeaId: args.clipIdeaId,
      doc: await args.makeDefault(),
      createdByUserId: args.userId,
    })
    .onConflictDoNothing({ target: clipEdits.clipIdeaId });
  const created = await selectEdit(args.clipIdeaId);
  if (!created) throw new Error("Failed to create clip edit");
  return created;
}

async function selectEdit(
  clipIdeaId: string,
): Promise<{ id: string; revision: number; doc: ClipEditDoc } | null> {
  const [row] = await db
    .select({ id: clipEdits.id, revision: clipEdits.revision, doc: clipEdits.doc })
    .from(clipEdits)
    .where(eq(clipEdits.clipIdeaId, clipIdeaId))
    .limit(1);
  if (!row) return null;
  const parsed = parseDoc(row.doc);
  if (!parsed.ok) throw new Error(`Stored clip edit ${row.id} is invalid: ${parsed.error}`);
  return { id: row.id, revision: row.revision, doc: parsed.doc };
}
