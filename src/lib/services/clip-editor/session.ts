/**
 * Editor session — everything the clip editor needs to open on one clip
 * idea, in one round trip: the idea, its (lazily created) edit document, a
 * playable source URL, and the transcript words around the clip.
 */
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipEdits,
  clipIdeas,
  clipRenders,
  clipSections,
  formats,
  productionItems,
  transcripts,
} from "@/lib/db/schema";
import { resolveClipAspectRatio } from "@/lib/db/formats";
import { getPresignedGetUrl } from "@/lib/s3";
import { applyLook, clipLookSchema, createDefaultDoc, parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { resolveTranscriptWords, type EditorWord } from "@/lib/clip-editor/words";
import { MIN_TRIM_SEC, MIN_TRIM_SHARE } from "@/lib/clip-editor/trim-habits";
import { loadTrimHabits } from "./trim-habits";
import { brandSpellingDocs, carrySiblingFixes } from "@/lib/clip-editor/carry-fixes";
import { loadBrandSpellings } from "./brand-spellings";
import type { TranscriptSpeaker } from "@/lib/diarization/types";
import { toRenderStatus, type ClipRenderStatus } from "./render-status";
import { ensureClipPostDraft, type ClipPost } from "./post-draft";
import { previewUrlFor } from "@/lib/services/design-editor/assets";
import { loadEditorReviewNotes, type EditorReviewNotes } from "./review-notes";
import type { SupportingMoment } from "@/lib/clip-stitch";
import { needsStitchSuggest } from "@/lib/clip-stitch";

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
  /** The target format's saved look (what new edits start from), if any. */
  formatLook: { formatId: string; savedAt: string | null } | null;
  /** clip-trim M4: this format's median opening cut, offered as one-click
   *  "Skip the run-up" on ideas written before the writer learned it
   *  (hook-v1–v3). Null for newer ideas, other kinds of idea, or a format
   *  whose editors rarely cut the opening. */
  runUpHabit?: { headSec: number; headCut: number; clips: number } | null;
  edit: { id: string; revision: number; doc: ClipEditDoc };
  /** A browser URL per image layer id in the doc (logos). Layers added in
   *  the session bring their own URL from the logo picker. */
  imageUrls: Record<string, string>;
  /** A playable URL per uploaded clip in the doc (`doc.media`). Clips
   *  uploaded in the session bring their own. */
  mediaUrls: Record<string, string>;
  source: {
    productionItemId: string;
    title: string | null;
    videoUrl: string;
    durationSec: number | null;
  };
  /** Every word of the source transcript, in order. */
  words: EditorWord[];
  /** Spelling fixes this edit started with, carried from other clips of the
   *  same video ("ChatGPT", "Rork"). Only on the open that created the edit;
   *  empty after. See carry-fixes.ts. */
  carriedFixes: string[];
  /** For an edit that already existed: spelling fixes made in other clips of
   *  this video since, that this clip hasn't got — offered as one click
   *  ("Apply 2 fixes"), never applied on their own. `wordEdits` is exactly
   *  what applying adds (the clip's own corrections are never in it). Null
   *  when there's nothing to offer. */
  offeredFixes: { names: string[]; wordEdits: Record<string, string>; fromBrand: boolean } | null;
  /** Detected speakers (null until speaker detection has run). */
  speakers: TranscriptSpeaker[] | null;
  /** True when word timings were interpolated from caption segments. */
  wordsSynthetic: boolean;
  latestRender: ClipRenderStatus | null;
  /** The post this clip goes out with (the queue-side item), and whether
   *  its copy is written yet. Opening the editor starts the draft — see
   *  post-draft.ts. Null for legacy ideas without an item. */
  post: ClipPost | null;
  /** Open review notes on the clip's post, for the timeline (M3). Null
   *  before the idea has a post. */
  reviewNotes: EditorReviewNotes | null;
  /** Lines from elsewhere in the source the section picker suggests
   *  stitching into this clip (clip stitching M2) — offered with one-click
   *  Add, never added on their own. Empty for pre-v2 or killed sections. */
  supportingMoments: SupportingMoment[];
  /** The section predates section-picker v2 and was never asked for stitch
   *  lines (M3): the editor POSTs `editor/stitch` to have the worker find
   *  them, then polls. */
  stitchPending: boolean;
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
      generatedBy: clipIdeas.generatedBy,
      acceptedProductionItemId: clipIdeas.acceptedProductionItemId,
      supportingMoments: clipSections.supportingMoments,
      sectionKilledAt: clipSections.killedAt,
      sectionPromptVersion: clipSections.promptVersion,
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
    .leftJoin(clipSections, eq(clipSections.id, clipIdeas.clipSectionId))
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

  // The WHOLE transcript: the editor shows the full source so any part of it
  // can be edited into the clip. (~60 bytes/word — an hour-long podcast is
  // well under 1 MB before gzip.)
  const { words, synthetic } = resolveTranscriptWords(transcript);

  let carriedFixes: string[] = [];
  let createdHere = false;
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
      const styled = look?.success ? applyLook(doc, look.data) : doc;
      // Names a teammate already fixed in another clip of this video start
      // fixed here too.
      const carried = carrySiblingFixes(
        styled,
        words,
        await loadSiblingDocs(row.sourceProductionItemId, row.id),
      );
      carriedFixes = carried.carried;
      createdHere = true;
      return carried.doc;
    },
  });

  // An edit someone already worked on is never changed behind their back —
  // fixes made elsewhere since are offered instead (fix-names-once M2). Any
  // edit, new or not, is also offered the brand's spellings: names fixed in
  // 2+ other videos of this brand (M3). Those are never applied on their own.
  // Sibling fixes come last so this video's own spelling wins.
  let offeredFixes: ClipEditorSession["offeredFixes"] = null;
  const siblings = createdHere ? [] : await loadSiblingDocs(row.sourceProductionItemId, row.id);
  const sameVideo = createdHere ? null : carrySiblingFixes(edit.doc, words, siblings);
  const brandDocs = brandSpellingDocs(
    // A brand sweep that fails costs the offer, never the editor.
    await loadBrandSpellings(brand).catch(() => []),
    words,
    edit.doc,
  );
  const offer = brandDocs.length > 0 ? carrySiblingFixes(edit.doc, words, [...brandDocs, ...siblings]) : sameVideo;
  if (offer && offer.carried.length > 0) {
    const fromVideo = new Set(sameVideo?.carried ?? []);
    offeredFixes = {
      names: offer.carried,
      wordEdits: offer.added,
      fromBrand: offer.carried.some((n) => !fromVideo.has(n)),
    };
  }

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
    formatLook: await loadFormatLookInfo(brand, row.targetFormat),
    runUpHabit: await loadRunUpHabit(brand, row.targetFormat, row.generatedBy),
    // Opening the editor is the moment the post gets drafted (it used to
    // wait for export), so the Post tab has copy to show by the time the
    // cut is done.
    post: await ensureClipPostDraft(row.id),
    edit,
    imageUrls: await resolveLayerImageUrls(edit.doc),
    mediaUrls: await resolveMediaUrls(edit.doc),
    source: {
      productionItemId: row.sourceProductionItemId,
      title: row.sourceTitle,
      videoUrl,
      durationSec: transcript.durationSec ? Number(transcript.durationSec) : null,
    },
    words,
    carriedFixes,
    offeredFixes,
    speakers: transcript.speakers ?? null,
    wordsSynthetic: synthetic,
    latestRender: render ? toRenderStatus(render) : null,
    reviewNotes: row.acceptedProductionItemId
      ? await loadEditorReviewNotes(row.acceptedProductionItemId)
      : null,
    supportingMoments: row.sectionKilledAt ? [] : (row.supportingMoments ?? []),
    stitchPending:
      row.sectionPromptVersion != null &&
      needsStitchSuggest({
        promptVersion: row.sectionPromptVersion,
        supportingMoments: row.supportingMoments,
        killedAt: row.sectionKilledAt,
      }),
  };
}

async function resolveLayerImageUrls(doc: ClipEditDoc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const layer of doc.layers) {
    if (layer.type === "image") out[layer.id] = await previewUrlFor(layer.src);
  }
  return out;
}

async function resolveMediaUrls(doc: ClipEditDoc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of doc.media) out[m.id] = await getPresignedGetUrl(m.key, 4 * 3600);
  return out;
}

/** Ideas from hook-v4 on were written knowing the format's trim habit. */
const TRIM_AWARE_HOOK_VERSION = 4;

async function loadRunUpHabit(
  brand: string,
  targetFormat: string | null,
  generatedBy: string | null,
): Promise<ClipEditorSession["runUpHabit"]> {
  const v = generatedBy?.match(/:hook-v(\d+)$/);
  if (!targetFormat || !v || Number(v[1]) >= TRIM_AWARE_HOOK_VERSION) return null;
  try {
    const s = await loadTrimHabits({ brand, formatName: targetFormat });
    if (!s || s.headCut / s.clips < MIN_TRIM_SHARE || s.medianHeadSec < MIN_TRIM_SEC) return null;
    return { headSec: s.medianHeadSec, headCut: s.headCut, clips: s.clips };
  } catch {
    return null; // fail-soft: the editor opens without the offer
  }
}

async function loadFormatLookInfo(brand: string, targetFormat: string | null): Promise<{ formatId: string; savedAt: string | null } | null> {
  if (!targetFormat) return null;
  const [f] = await db
    .select({ id: formats.id, look: formats.clipTemplate, savedAt: formats.clipTemplateUpdatedAt })
    .from(formats)
    .where(and(eq(formats.brand, brand), eq(formats.name, targetFormat)))
    .limit(1);
  return f?.look ? { formatId: f.id, savedAt: f.savedAt?.toISOString() ?? null } : null;
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

/** The edit docs of every OTHER clip cut from this source, oldest edit
 *  first (so the newest spelling of a fix wins). Unparseable docs are
 *  skipped. */
export async function loadSiblingDocs(
  sourceProductionItemId: string,
  clipIdeaId: string,
): Promise<ClipEditDoc[]> {
  const rows = await db
    .select({ doc: clipEdits.doc })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .where(
      and(
        eq(clipIdeas.sourceProductionItemId, sourceProductionItemId),
        ne(clipEdits.clipIdeaId, clipIdeaId),
      ),
    )
    .orderBy(asc(clipEdits.updatedAt));
  return rows.flatMap((r) => {
    const parsed = parseDoc(r.doc);
    return parsed.ok ? [parsed.doc] : [];
  });
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
