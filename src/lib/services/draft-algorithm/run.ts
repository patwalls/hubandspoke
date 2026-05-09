import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  formats,
  productionItemMedia,
  productionItems,
} from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateDraft,
  GENERATED_BY as AGENT_GENERATED_BY,
  PROMPT_VERSION,
  type MediaAction,
  type MediaContext,
} from "@/lib/draft-agent";
import {
  getSchemaForPostType,
  PLATFORM_FIELD_MAP,
  type PostType,
} from "@/lib/platform-field-schemas";
import { getMediaRule } from "@/lib/platform-media-rules";
import { addMediaRowsToDraft } from "@/lib/services/draft-media";
import { getTopPerformingCaptions } from "./exemplars";

// The Draft Algorithm — V1.
//
// Generalizes the IG-only `generate-instagram-caption` path. Same Opus 4.7
// agent, same cached preamble, same demote-then-insert tx — but:
//   1. Source-type aware: skips repost (verbatim seed stays) and clip ideas
//      (their copy comes from the clip-idea pipeline). Runs on cross_post
//      and on `original` items that have a pillar (= a repurpose).
//   2. Platform-general: every post type in PLATFORM_FIELD_MAP that's in
//      the V1 supported set gets a draft. Schema is resolved per-postType.
//   3. Exemplars are view-ranked, not recency-ranked. See exemplars.ts.
//
// Bumping `DRAFT_ALGORITHM_VERSION` invalidates audits — use it when the
// branch logic / data assembly changes meaningfully. Prompt-string changes
// belong in `PROMPT_VERSION` on the agent.
//
// V1.1 (2026-05-08): the agent now also picks a `media_action` (attach
// pillar full video / attach pillar poster / none); the service translates
// that into a `production_item_media` row inside the same tx. The
// per-format Skill text is the directive — see draft-agent.ts MEDIA ACTION
// RULES. Idempotent on re-run: if any media row already exists on the
// item, media attachment is skipped (preserves manual edits).
export const DRAFT_ALGORITHM_VERSION = "1.1";
export const GENERATED_BY = `draft-algo:v${DRAFT_ALGORITHM_VERSION}:${AGENT_GENERATED_BY}`;

// Translate the agent's MediaAction into a concrete file payload for
// `addMediaRowsToDraft`, or return null if unfulfillable. Two reasons we'd
// return null even when the agent picked something:
//   1. The pillar doesn't have the requested asset (e.g. agent said attach
//      full video but pillar has no archived video).
//   2. The platform rule rejects the kind (e.g. youtube_community is text-
//      only). The prompt also surfaces the rule, so this is belt-and-braces.
function resolveAttachment(
  action: MediaAction,
  pillar: {
    mediaS3Bucket: string | null;
    mediaS3Key: string | null;
    mediaContentType: string | null;
    posterS3Key: string | null;
  },
  rule: ReturnType<typeof getMediaRule>,
): {
  s3Bucket: string;
  s3Key: string;
  contentType: string;
  sizeBytes: number;
  kind: "image" | "video";
  posterS3Key?: string | null;
} | null {
  if (action === "attach_pillar_full_video") {
    if (!pillar.mediaS3Key || !pillar.mediaS3Bucket) return null;
    if (!rule.allowedKinds.includes("video")) return null;
    return {
      s3Bucket: pillar.mediaS3Bucket,
      s3Key: pillar.mediaS3Key,
      contentType: pillar.mediaContentType ?? "video/mp4",
      // sizeBytes is required by AddDraftMediaInput's schema, but we don't
      // re-fetch the S3 HEAD here — the upload-confirm path already
      // populated it on the pillar. 0 is a benign placeholder; consumers
      // that care (UI byte-meter) read the row's stored value, not this.
      sizeBytes: 0,
      kind: "video",
      posterS3Key: pillar.posterS3Key ?? null,
    };
  }
  if (action === "attach_pillar_poster") {
    if (!pillar.posterS3Key || !pillar.mediaS3Bucket) return null;
    if (!rule.allowedKinds.includes("image")) return null;
    return {
      s3Bucket: pillar.mediaS3Bucket,
      s3Key: pillar.posterS3Key,
      // Posters are archived as JPEG by the YouTube enrichment path
      // (services/enrichment/youtube.ts:archiveRemoteToS3).
      contentType: "image/jpeg",
      sizeBytes: 0,
      kind: "image",
    };
  }
  return null;
}

// Platforms the algorithm drafts for in V1. Newsletter + youtube_long are
// out of scope — editors hand-write those today and the leverage isn't
// there yet.
const SUPPORTED_POST_TYPES: ReadonlySet<PostType> = new Set<PostType>([
  "x",
  "linkedin",
  "instagram_post",
  "instagram_reel",
  "instagram_story",
  "tiktok",
  "youtube_community",
  "youtube_shorts",
  "threads",
]);

export type DraftAlgorithmSkipReason =
  | "item_not_found"
  | "repost_kept_verbatim"
  | "pillar_item_no_draft"
  | "unsupported_post_type"
  | "no_platform_schema"
  | "no_caption_field"
  | "already_filled"
  | "no_transcript";

export interface RunDraftAlgorithmResult {
  status: "generated" | "skipped";
  reason?: DraftAlgorithmSkipReason;
  draftId?: string;
  /** What the agent wrote into the primary caption field — handy for the
   *  manual endpoint to surface in its response without an extra DB read. */
  captionPreview?: string;
}

export interface RunDraftAlgorithmOpts {
  /** Override the "already-filled" idempotency guard. Set when an editor
   *  explicitly clicks Regenerate on a draft that already has content. */
  force?: boolean;
  actorUserId?: string | null;
}

/**
 * Run the Draft Algorithm against a production item.
 *
 * Idempotent on retry: skips with `already_filled` when a non-seeded
 * caption is already present and `force` is false. The auto-fire path
 * (cross-post + repurpose routes) fires-and-forgets after item creation,
 * so a retry must never clobber editor edits.
 */
export async function runDraftAlgorithm(
  productionItemId: string,
  opts: RunDraftAlgorithmOpts = {},
): Promise<RunDraftAlgorithmResult> {
  const { force = false, actorUserId = null } = opts;

  const [item] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) return { status: "skipped", reason: "item_not_found" };

  // Source-type branch. The algorithm fires on items that need a new
  // first draft grounded in the pillar transcript + view-ranked exemplars.
  // Repost is the one explicit skip — same content, same platform, the
  // seed already copied the source caption verbatim.
  //
  // The full enum (see schema.ts:222 + comment): `original` (pillar OR
  // manually-created repurpose, the default), `repost`, `cross_post`,
  // `clip` (promoted from clip-idea), `repurposed` (auto-created by the
  // threshold-monitor-sweep cron). Both repurpose paths land here as
  // "draft me" — the manual route uses the `original` default + sets
  // `pillarContentItemId`, the cron writes `repurposed` explicitly.
  switch (item.sourceType) {
    case "repost":
      return { status: "skipped", reason: "repost_kept_verbatim" };
    case "original":
      // `original` is two cases:
      //   - Pillar items (no parent) — these ARE the source. Long-form,
      //     editors hand-write the copy.
      //   - Manually-created repurpose items (pillarContentItemId set) —
      //     fall through.
      if (!item.pillarContentItemId) {
        return { status: "skipped", reason: "pillar_item_no_draft" };
      }
      break;
    case "cross_post":
    case "clip":
    case "repurposed":
      // cross_post: different platform than the source; pillar transcript
      //   is the right grounding.
      // clip: paired to a clip_idea (which sets hook + angle metadata),
      //   but the post-side caption still needs drafting — same as IG had
      //   under the old path.
      // repurposed: cron-created derivative of a pillar; same shape as
      //   the manual repurpose path, just a different `sourceType` label.
      break;
    default:
      return { status: "skipped", reason: "pillar_item_no_draft" };
  }

  if (!item.postType || !SUPPORTED_POST_TYPES.has(item.postType as PostType)) {
    return { status: "skipped", reason: "unsupported_post_type" };
  }

  const fieldSchema = getSchemaForPostType(item.postType);
  if (!fieldSchema) return { status: "skipped", reason: "no_platform_schema" };

  const captionFieldKey =
    PLATFORM_FIELD_MAP[item.postType as PostType]?.caption ?? null;
  if (!captionFieldKey) return { status: "skipped", reason: "no_caption_field" };

  // Idempotency guard. The auto-fire path runs right after seedRepostContent
  // (cross-post) writes the source's contentBody into the draft, so the
  // primary caption field is already non-empty — but it's just the source
  // body. We distinguish via `generatedBy`: "copy:source" means seed
  // (overwrite welcome); anything else (incl. "user", a prior draft-algo
  // run) means a human or agent has touched it (don't clobber unless
  // forced). Repurpose has no draft yet so this branch is harmless there.
  const [currentDraft] = await db
    .select()
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, productionItemId),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);

  if (!force && currentDraft) {
    const existingCaption = (currentDraft.content as Record<string, unknown> | null)?.[
      captionFieldKey
    ];
    const isSeededCopy = currentDraft.generatedBy === "copy:source";
    const hasMeaningfulCaption =
      typeof existingCaption === "string" && existingCaption.trim().length > 0;
    if (hasMeaningfulCaption && !isSeededCopy) {
      return { status: "skipped", reason: "already_filled" };
    }
  }

  // Transcript — pillar's transcript for derivatives, the item's own for
  // the (rare) case of an originally-cross_post that points at itself.
  const transcriptSourceId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(transcriptSourceId);
  if (!transcript) return { status: "skipped", reason: "no_transcript" };

  // Format instructions (editorial voice / style guide). Optional.
  let formatInstructions: string | null = null;
  if (item.format) {
    const [fmt] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
      .limit(1);
    formatInstructions = fmt?.instructions ?? null;
  }

  // Past captions for this exact (brand, post_type), view-ranked. The
  // single biggest quality lever vs. the previous recency ordering — top
  // performers carry the structural signal we want the model to mirror.
  const pastCaptions = await getTopPerformingCaptions({
    brand: item.brand,
    postType: item.postType,
    excludeId: productionItemId,
  });

  // Pillar title + media for context when this is a derivative. The media
  // metadata (S3 keys + poster) drives the V1.1 MediaContext: the agent
  // sees what's available, picks an action, and we attach in the tx below.
  let pillarTitle: string | null = item.title;
  let pillar: {
    id: string;
    mediaS3Bucket: string | null;
    mediaS3Key: string | null;
    mediaContentType: string | null;
    posterS3Key: string | null;
  } | null = null;
  if (item.pillarContentItemId) {
    const [row] = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        mediaS3Bucket: productionItems.mediaS3Bucket,
        mediaS3Key: productionItems.mediaS3Key,
        mediaContentType: productionItems.mediaContentType,
        posterS3Key: productionItems.posterS3Key,
      })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (row) {
      pillarTitle = row.title;
      pillar = {
        id: row.id,
        mediaS3Bucket: row.mediaS3Bucket,
        mediaS3Key: row.mediaS3Key,
        mediaContentType: row.mediaContentType,
        posterS3Key: row.posterS3Key,
      };
    }
  }

  const platformArr = (item.platform as string[] | null) ?? [item.postType];

  // Build the MediaContext for the agent. Tells it what pillar media is
  // archived and what the target platform's media rule allows.
  const mediaRule = getMediaRule(item.postType);
  const mediaContext: MediaContext = {
    pillarHasFullVideo: !!pillar?.mediaS3Key,
    pillarHasPoster: !!pillar?.posterS3Key,
    platformMode: mediaRule.mode,
    platformAllowedKinds: mediaRule.allowedKinds,
  };

  const result = await generateDraft({
    item: {
      id: item.id,
      title: item.title,
      format: item.format,
      platform: platformArr,
      brand: item.brand,
    },
    fieldSchema,
    formatInstructions,
    pillarTitle,
    transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
    transcriptDurationSec: transcript.durationSec,
    pastCaptions,
    mediaContext,
  });

  // Demote previous current + insert new current as version+1 in a tx —
  // keeps the partial unique index on (production_item_id) WHERE is_current
  // happy. Works for first insert too (prevCurrent is undefined → version 1).
  const inserted = await db.transaction(async (tx) => {
    const [prevCurrent] = await tx
      .select({ version: contentDrafts.version })
      .from(contentDrafts)
      .where(eq(contentDrafts.productionItemId, productionItemId))
      .orderBy(desc(contentDrafts.version))
      .limit(1);
    const nextVersion = (prevCurrent?.version ?? 0) + 1;

    await tx
      .update(contentDrafts)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(
        and(
          eq(contentDrafts.productionItemId, productionItemId),
          eq(contentDrafts.isCurrent, true),
        ),
      );

    const [row] = await tx
      .insert(contentDrafts)
      .values({
        productionItemId,
        version: nextVersion,
        isCurrent: true,
        content: result.content,
        fieldSchemaSnapshot: fieldSchema,
        generatedBy: GENERATED_BY,
        promptVersion: PROMPT_VERSION,
        modelUsage: result.modelUsage,
        createdByUserId: actorUserId,
      })
      .returning();

    // V1.1 media attachment. Only attach when:
    //   1. Agent picked an actionable action (not "none").
    //   2. Item has zero existing media rows — preserves manual edits and
    //      makes Redraft idempotent (re-runs don't churn media).
    //   3. The action is fulfillable: pillar has the requested asset AND
    //      the platform rule accepts the implied kind. Belt-and-braces with
    //      the prompt — if the model misjudges, we silently skip here.
    if (result.mediaAction !== "none" && pillar) {
      const [hasMedia] = await tx
        .select({ id: productionItemMedia.id })
        .from(productionItemMedia)
        .where(eq(productionItemMedia.productionItemId, productionItemId))
        .limit(1);
      if (!hasMedia) {
        const file = resolveAttachment(result.mediaAction, pillar, mediaRule);
        if (file) {
          await addMediaRowsToDraft(tx, {
            itemId: productionItemId,
            files: [file],
          });
          // Mirror to the legacy single-media columns on production_items
          // (the index-0 carousel row is the source of truth; legacy
          // columns are a derived cache that other writers — enrichment,
          // seedRepostContent, the media route — keep in sync).
          await tx
            .update(productionItems)
            .set({
              mediaS3Bucket: file.s3Bucket,
              mediaS3Key: file.s3Key,
              mediaContentType: file.contentType,
              posterS3Key: file.posterS3Key ?? null,
            })
            .where(eq(productionItems.id, productionItemId));
        }
      }
    }

    return row;
  });

  const generatedCaption = (result.content as Record<string, unknown>)[captionFieldKey];

  return {
    status: "generated",
    draftId: inserted.id,
    captionPreview:
      typeof generatedCaption === "string" ? generatedCaption : undefined,
  };
}
