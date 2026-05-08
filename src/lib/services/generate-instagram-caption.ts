import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, formats, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateDraft,
  GENERATED_BY,
  PROMPT_VERSION,
  type PastCaptionExample,
} from "@/lib/draft-agent";
import {
  PLATFORM_FIELD_MAP,
  resolveSchemaForPlatforms,
} from "@/lib/platform-field-schemas";

/**
 * Cap on past captions to surface to the model. Eight is plenty: the model
 * picks up tone from 3-4 strong exemplars. Beyond ~8 we just bloat the
 * prompt and start spending input tokens on captions the model already
 * pattern-matched on. Most-recent-first.
 */
const MAX_PAST_CAPTIONS = 8;

export interface GenerateInstagramCaptionResult {
  status: "generated" | "skipped";
  reason?: string;
  draftId?: string;
  /** What the agent wrote into the caption field — handy for the manual
   *  endpoint to surface in its response without an extra DB read. */
  captionPreview?: string;
}

/**
 * Auto-generate (or regenerate) an Instagram-platform caption for a
 * production item. Pulls editorial signal from three sources:
 *   1. The pillar's transcript — for substantive specifics (numbers,
 *      named people, direct quotes) the caption should reference.
 *   2. The format's editorial notes — free-text style guidance the team
 *      maintains per format.
 *   3. The team's most recent published captions for the SAME format —
 *      the strongest tone signal we have, because they're real shipped
 *      copy on the same brand + format.
 *
 * Writes the result as a new `contentDrafts` row (demote-then-insert tx:
 * current row flips to `is_current=false`, new row inserts with version+1).
 *
 * Idempotent on retry: when a caption already exists in the current draft
 * and `force` is false, we skip with reason "already_filled". The worker
 * task fire-and-forgets after a draft is seeded, so a retry shouldn't
 * clobber the editor's manual edits.
 */
export async function generateInstagramCaptionForItem(
  productionItemId: string,
  opts: { force?: boolean; actorUserId?: string | null } = {},
): Promise<GenerateInstagramCaptionResult> {
  const { force = false, actorUserId = null } = opts;

  const [item] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) {
    return { status: "skipped", reason: "item_not_found" };
  }

  if (!item.postType || !item.postType.startsWith("instagram_")) {
    return { status: "skipped", reason: "not_instagram" };
  }

  const platformArr = (item.platform as string[] | null) ?? null;
  const resolved = resolveSchemaForPlatforms(platformArr);
  if (!platformArr || platformArr.length === 0 || !resolved.schema || !resolved.key) {
    return { status: "skipped", reason: "no_platform_schema" };
  }
  const fieldSchema = resolved.schema;
  const captionFieldKey = PLATFORM_FIELD_MAP[resolved.key]?.caption ?? null;
  if (!captionFieldKey) {
    return { status: "skipped", reason: "no_caption_field" };
  }

  // Idempotency guard. The auto-fire path runs right after seedRepostContent
  // copies the source's captionContent into the draft, so the caption is
  // technically non-empty already — but it's just the source body. We
  // distinguish the two via `generatedBy`: "copy:source" means seeded copy
  // (overwrite is welcome); anything else (incl. "user", another agent run)
  // means a human or agent has touched it (don't clobber unless forced).
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

  // Transcript — pillar's transcript for derivatives, otherwise own.
  const transcriptSourceId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(transcriptSourceId);
  if (!transcript) {
    return { status: "skipped", reason: "no_transcript" };
  }

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

  // Past captions for this exact (brand, format, postType). Most recent
  // shipped copy is the strongest tone signal — these are the captions the
  // editor team already approved + published on this format. Exclude this
  // very item so we don't echo the seeded source-body copy back as an
  // exemplar.
  const pastCaptions: PastCaptionExample[] = item.format
    ? (
        await db
          .select({
            caption: productionItems.contentBody,
            publishedAt: productionItems.publishedAt,
            publishedLink: productionItems.publishedLink,
            views: productionItems.views,
          })
          .from(productionItems)
          .where(
            and(
              eq(productionItems.brand, item.brand),
              eq(productionItems.format, item.format),
              eq(productionItems.postType, item.postType),
              eq(productionItems.status, "Published"),
              isNotNull(productionItems.contentBody),
              ne(productionItems.id, productionItemId),
              // Drop empty strings — `contentBody` is text, IS NOT NULL
              // alone keeps "" which adds noise to the prompt.
              sql`length(trim(${productionItems.contentBody})) > 0`,
            ),
          )
          .orderBy(desc(productionItems.publishedAt))
          .limit(MAX_PAST_CAPTIONS)
      ).map((row) => ({
        caption: row.caption ?? "",
        publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        publishedLink: row.publishedLink ?? null,
        views: row.views ?? null,
      }))
    : [];

  // Pillar title for context.
  let pillarTitle: string | null = item.title;
  if (item.pillarContentItemId) {
    const [pillar] = await db
      .select({ title: productionItems.title })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (pillar) pillarTitle = pillar.title;
  }

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
  // happy.
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
