import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, formats, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateDraft,
  GENERATED_BY as AGENT_GENERATED_BY,
  PROMPT_VERSION,
} from "@/lib/draft-agent";
import {
  getSchemaForPostType,
  PLATFORM_FIELD_MAP,
  type PostType,
} from "@/lib/platform-field-schemas";
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
export const DRAFT_ALGORITHM_VERSION = 1;
export const GENERATED_BY = `draft-algo:v${DRAFT_ALGORITHM_VERSION}:${AGENT_GENERATED_BY}`;

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

  // Pillar title for context when this is a derivative.
  let pillarTitle: string | null = item.title;
  if (item.pillarContentItemId) {
    const [pillar] = await db
      .select({ title: productionItems.title })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (pillar) pillarTitle = pillar.title;
  }

  const platformArr = (item.platform as string[] | null) ?? [item.postType];

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
