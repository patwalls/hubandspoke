import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  formats,
  productionItems,
  type ContentDraftContent,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import {
  PLATFORM_FIELD_MAP,
  type PostType,
} from "@/lib/platform-field-schemas";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";
import {
  generateTrackedCta,
  TRACKED_CTA_VERSION,
} from "./tracked-cta";

// Focused regenerate path for the reply CTA only. Sits alongside the full
// draft-algorithm-run path (`./run.ts`) — that one regenerates the body
// AND the cta together (with `force=true`) and would clobber a hand-typed
// tweet. Editors need a "just refresh the reply" button for when the body
// is fine but the CTA copy / link is wrong. This service does:
//
//   1. Resolve channel + utm_campaign + the current post body from the item.
//   2. Delegate to generateTrackedCta (the shared smart-CTA service): it reads
//      the post body + format Skill + lead-magnet catalog, picks a target
//      (guest episode first, else best lead magnet), mints ONE tracked
//      go.starterstory.com link for this post, and returns the final reply.
//   3. Clone-on-write: insert a new content_drafts row that preserves
//      every other content key from the current draft and updates only
//      `cta`. Records one content_changed event on the cta field so the
//      activity feed reflects who regenerated it.
//
// Skip codes mirror the main algorithm's pattern so the route's error
// shape stays consistent.

// Mirrors the model tracked-cta actually calls; baked into the generated-by
// version tag so drafts record which engine produced the CTA.
const MODEL = "gpt-4.1";
export const REGENERATE_CTA_VERSION = TRACKED_CTA_VERSION;
export const REGENERATE_CTA_GENERATED_BY = `regen-cta:v${REGENERATE_CTA_VERSION}:${MODEL}`;

interface RegenerateCtaArgs {
  productionItemId: string;
  actorUserId: string | null;
}

export type RegenerateCtaSkipReason =
  | "item_not_found"
  | "no_cta_field"
  | "no_current_draft"
  | "unsupported_post_type";

export interface RegenerateCtaResult {
  status: "generated" | "skipped";
  reason?: RegenerateCtaSkipReason;
  draftId?: string;
  ctaPreview?: string;
}

// Mirror of CTA_CHANNEL_BY_POST_TYPE in `./run.ts`. Keep in sync — both
// gate "this post type supports a CTA reply". When adding a new post
// type to one, add it to the other.
const CTA_CHANNEL_BY_POST_TYPE: Partial<Record<PostType, string>> = {
  x: "x",
  linkedin: "linkedin",
  youtube_community: "ytcommunity",
  threads: "threads",
};

export async function regenerateCtaForItem(
  args: RegenerateCtaArgs,
): Promise<RegenerateCtaResult> {
  const { productionItemId, actorUserId } = args;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      brand: productionItems.brand,
      postType: productionItems.postType,
      utmCampaign: productionItems.utmCampaign,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) return { status: "skipped", reason: "item_not_found" };

  const postType = item.postType as PostType | null;
  if (!postType) return { status: "skipped", reason: "unsupported_post_type" };

  const channel = CTA_CHANNEL_BY_POST_TYPE[postType];
  const ctaFieldKey = PLATFORM_FIELD_MAP[postType]?.cta ?? null;
  if (!channel || !ctaFieldKey) {
    return { status: "skipped", reason: "no_cta_field" };
  }

  const [current] = await db
    .select()
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, productionItemId),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);
  if (!current) return { status: "skipped", reason: "no_current_draft" };

  // Resolve pillar title for the episode lookup. The pillar carries the
  // long-form episode title; the derivative row's title is often a copy or a
  // clipped hook — searching with the pillar title gives the episode search
  // the best chance of finding the starterstory.com episode page.
  let pillarTitle: string | null = item.title;
  if (item.pillarContentItemId) {
    const [pillar] = await db
      .select({ title: productionItems.title })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (pillar?.title) pillarTitle = pillar.title;
  }

  let formatInstructions: string | null = null;
  if (item.format) {
    const [fmt] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
      .limit(1);
    formatInstructions = fmt?.instructions ?? null;
  }

  // The caption this CTA replies to — feed it to the generator so the target
  // and copy actually reflect what the post is about.
  const prevContent = (current.content ?? {}) as ContentDraftContent;
  const captionKey = PLATFORM_FIELD_MAP[postType]?.caption ?? null;
  const captionRaw = captionKey ? prevContent[captionKey] : null;
  const postBody = Array.isArray(captionRaw)
    ? captionRaw.join("\n")
    : typeof captionRaw === "string"
      ? captionRaw
      : null;

  const tracked = await generateTrackedCta({
    productionItemId,
    channel,
    utmCampaign: item.utmCampaign ?? null,
    postBody,
    pillarTitle,
    formatInstructions,
  });
  const newCta = tracked.cta;

  // Clone-on-write: demote current, insert v+1 with the updated cta.
  // Preserve every other content key from the current draft so a body
  // the editor hand-typed doesn't get wiped. Keep the schema snapshot
  // from the current draft (it already permits cta in v2 schemas; for
  // an old v1 snapshot the PATCH endpoint will reject future cta edits
  // but that's the rare case and a Redraft fixes it).
  const nextContent: ContentDraftContent = { ...prevContent, [ctaFieldKey]: newCta };

  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(contentDrafts)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(contentDrafts.id, current.id));

    const [next] = await tx
      .insert(contentDrafts)
      .values({
        productionItemId,
        version: current.version + 1,
        isCurrent: true,
        content: nextContent,
        fieldSchemaSnapshot: current.fieldSchemaSnapshot as FormatFieldSchema,
        generatedBy: REGENERATE_CTA_GENERATED_BY,
        promptVersion: null,
        modelUsage: null,
        createdByUserId: actorUserId,
      })
      .returning();

    const changes: ContentChange[] = [
      {
        target: {
          kind: "draft_field",
          draftId: next.id,
          version: next.version,
          field: ctaFieldKey,
        },
        from: typeof prevContent[ctaFieldKey] === "string"
          ? (prevContent[ctaFieldKey] as string)
          : null,
        to: newCta,
      },
    ];
    await recordContentChanges({
      tx,
      contentItemId: productionItemId,
      userId: null,
      // Same algorithm-source as the full draft-algorithm — regenerate-cta
      // is a focused variant, not a separate engine. Activity feed badge
      // says "Draft Algorithm" for both, which is the right read.
      source: { kind: "algorithm", name: "draft-algorithm" },
      changes,
    });

    return next;
  });

  console.info(
    `regenerate-cta v${REGENERATE_CTA_VERSION} item=${productionItemId} format="${item.format ?? "(none)"}" channel=${channel} target=${tracked.targetType} slug=${tracked.slug}`,
  );

  return {
    status: "generated",
    draftId: inserted.id,
    ctaPreview: newCta,
  };
}
