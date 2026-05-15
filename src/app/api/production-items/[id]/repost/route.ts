import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { resolveEditor } from "@/lib/services/assignees";
import { buildRepostValues } from "@/lib/services/repost-values";
import { recordItemCreated } from "@/lib/services/item-created";
import { seedRepostContent } from "@/lib/services/repost-seed";
import { hasAnyCarouselRow } from "@/lib/services/media-introspection";
import { isVideoBearingPostType } from "@/lib/platform-media-rules";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import {
  hasDescriptableMedia,
  loadPillarForSource,
} from "@/lib/services/descript-derivative";
import { enqueue } from "@/jobs/enqueue";
import type { PostType } from "@/lib/platform-field-schemas";

// Platforms whose new repost rows get seeded with mirrored media + a v1
// content_drafts row at creation time. Other platforms still create the
// production_items row but skip seeding until they're wired up.
const SEEDED_POST_TYPES: ReadonlySet<PostType> = new Set<PostType>([
  "x",
  "instagram_post",
  "instagram_reel",
  "instagram_story",
  "linkedin",
  "tiktok",
]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Statuses the repost route accepts. Both creation paths (content-detail
 *  Actions → Repost and the queue v2 triage dialog) now pass
 *  `Ready To Publish` so reposts skip the Idea/Assigned review cycle.
 *  `Idea` stays accepted for back-compat with any older caller. */
const ACCEPTED_STATUSES = ["Idea", "Ready To Publish"] as const;
type AcceptedStatus = (typeof ACCEPTED_STATUSES)[number];

/**
 * POST /api/production-items/[id]/repost
 *
 * Body (all optional):
 *   - editorUserId: override the resolved editor (used by the queue
 *     triage dialog where the picker selects who'll do the work)
 *   - status: "Idea" | "Ready To Publish" — defaults to "Idea". The
 *     repost queue v2 sets "Ready To Publish" since reposts skip the
 *     usual review cycle.
 *
 * Creates a new `repost` production item that mirrors the source on the
 * same platform(s). Inherits title, thumbnail, format, pillar, and
 * brand from the source. Writes a `repost_created` content event so the
 * activity feed shows the lineage.
 */
export async function POST(request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id } = await context.params;

  // Parse optional body. Empty body is fine — keeps v1 callers working.
  const body = (await request.json().catch(() => ({}))) as {
    editorUserId?: unknown;
    status?: unknown;
  };
  const requestedStatus =
    typeof body.status === "string" &&
    (ACCEPTED_STATUSES as readonly string[]).includes(body.status)
      ? (body.status as AcceptedStatus)
      : "Idea";
  const requestedEditorUserId =
    typeof body.editorUserId === "string" && body.editorUserId.length > 0
      ? body.editorUserId
      : null;

  let [source] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json({ error: "Source item not found" }, { status: 404 });
  }

  // Best-effort: enrich the source first so the new repost inherits a
  // populated `contentBody` + media rows, even if the source was created
  // before the auto-enrich sweep had a chance to run. Synchronous wait —
  // the user explicitly wants to block on this.
  //
  // Two firing conditions:
  //   1. Source has never been enriched at all (`enrichmentCompletedAt` null).
  //      Standard fetch — `withMedia` defaults to false on the orchestrator,
  //      which matches the auto-sweep cost model.
  //   2. Source IS enriched but is a video-bearing post type with NO archived
  //      video on hand (no carousel rows AND no legacy `mediaS3Key`). The
  //      auto-sweep doesn't archive the MP4 (cost: 1 SC credit) — it only
  //      runs the photo / caption / transcript pass. Without this branch,
  //      reposting a Reel that the cron enriched but never downloaded gives
  //      the new repost zero media → black-box simulator. Force a
  //      `withMedia: true, force: true` re-enrichment to backfill (10 credits).
  //      Per-slide idempotency in `archiveCarouselMedia` makes this safe to
  //      re-run repeatedly.
  const sourceNeedsMedia =
    isVideoBearingPostType(source.postType) &&
    !source.mediaS3Key &&
    !(await hasAnyCarouselRow(source.id));
  if (sourceNeedsMedia || !source.enrichmentCompletedAt) {
    try {
      await enrichSingleItem(source.id, {
        withMedia: sourceNeedsMedia ? true : undefined,
        force: !!source.enrichmentCompletedAt && sourceNeedsMedia,
      });
      const [refreshed] = await db
        .select()
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      if (refreshed) source = refreshed;
    } catch (err) {
      console.error(
        `[repost] enrichment failed for source ${source.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Legacy/oddball items pre-date the accounts rollout — they don't have an
  // accountId/postType and aren't repost-eligible until backfilled.
  if (!source.accountId || !source.postType) {
    return NextResponse.json(
      { error: "Source item is missing accountId or postType — backfill required before reposting." },
      { status: 422 }
    );
  }

  // Hard gate: repost requires Descript-able media. Mirrors cross-post —
  // the source must have a composition, media of its own, or a pillar with
  // seed/media. The UI exposes this as `canRepost` so the button is
  // disabled when this would 400.
  const sourcePillar = await loadPillarForSource(source);
  if (!hasDescriptableMedia(source, sourcePillar)) {
    return NextResponse.json(
      {
        error:
          "No Descript-able media available. Repost needs the pillar's source video (or, when there's no upstream pillar, the source's own video). The Reel's exported media isn't usable — it's already cropped to its final aspect.",
      },
      { status: 400 }
    );
  }

  // Don't carry a stale `format` from the source — if it doesn't exist in
  // the brand's formats table, set null instead of propagating the drift.
  const formatCheck = await normalizeFormatForWrite(source.brand, source.format);
  const inheritedFormat = formatCheck.ok ? formatCheck.value : null;

  const editorUserId =
    requestedEditorUserId ??
    (await resolveEditor({
      brand: source.brand,
      sourceItemId: source.id,
      format: inheritedFormat,
    }));

  const baseValues = buildRepostValues(
    {
      id: source.id,
      brand: source.brand,
      title: source.title,
      thumbnail: source.thumbnail,
      accountId: source.accountId,
      postType: source.postType,
      platform: source.platform,
      format: inheritedFormat,
      pillarContentItemId: source.pillarContentItemId,
      pillarContentNotionId: source.pillarContentNotionId,
      evergreenReasoning: source.evergreenReasoning,
      mediaS3Bucket: source.mediaS3Bucket,
      mediaS3Key: source.mediaS3Key,
      mediaContentType: source.mediaContentType,
      posterS3Key: source.posterS3Key,
    },
    {
      utmCampaign: await generateUtmCampaign(source.title),
      editorUserId,
    }
  );

  // One transaction so we never leave a half-seeded repost. The seed step
  // is sub-50ms (≤4 small INSERTs), invisible next to the redirect.
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(productionItems)
      .values({
        ...baseValues,
        status: requestedStatus,
        createdVia: "api:repost",
      })
      .returning({ id: productionItems.id });
    await recordItemCreated(tx, {
      itemId: row.id,
      source: "api:repost",
      actorUserId,
      format: baseValues.format ?? null,
      sourceType: "repost",
      postType: baseValues.postType ?? null,
    });

    if (SEEDED_POST_TYPES.has(source.postType as PostType)) {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: row.id,
        postType: source.postType as PostType,
        sourceContentBody: source.contentBody,
        sourceLegacyMedia: source.mediaS3Key
          ? {
              s3Bucket: source.mediaS3Bucket,
              s3Key: source.mediaS3Key,
              contentType: source.mediaContentType,
              posterS3Key: source.posterS3Key,
            }
          : null,
        actorUserId,
      });
    }

    // Activity-feed event so the source's history shows where the new
    // repost came from. Both creation paths (manual Actions → Repost and
    // the queue triage dialog) now emit this so the lineage is visible
    // regardless of where the operator clicked.
    if (requestedStatus === "Ready To Publish") {
      await tx.insert(contentEvents).values({
        contentItemId: row.id,
        userId: actorUserId,
        eventType: "repost_created",
        payload: {
          type: "repost_created",
          sourceItemId: source.id,
          sourceTitle: source.title,
        },
      });
    }

    return row;
  });

  // After the seed tx commits, kick off the AI caption-generation primitive
  // for any IG draft. The agent reads the pillar transcript + past-format
  // captions and overwrites the seeded `copy:source` body with one grounded
  // in the team's voice for this exact format. Fire-and-forget — failure
  // here doesn't block the redirect to the new item.
  if (
    typeof source.postType === "string" &&
    source.postType.startsWith("instagram_")
  ) {
    try {
      await enqueue("generate-instagram-caption", {
        productionItemId: created.id,
      });
    } catch (err) {
      console.error("generate-ig-caption enqueue failed:", err);
    }
  }

  // Kick off the Descript composition copy. Not fire-and-forget: the user
  // picked this repost because the source has Descript-able media (gated
  // above), so they expect Descript work to happen. If the queue is down,
  // surface that rather than silently dropping it.
  await enqueue("descript-derivative-create", {
    derivativeItemId: created.id,
    sourceItemId: source.id,
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
