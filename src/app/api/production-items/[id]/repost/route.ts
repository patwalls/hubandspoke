import { NextResponse } from "next/server";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { resolveEditor } from "@/lib/services/assignees";
import { buildRepostValues } from "@/lib/services/repost-values";
import { recordItemCreated } from "@/lib/services/item-created";
import { seedRepostContent } from "@/lib/services/repost-seed";
import { stripDateOpenerWithLLM } from "@/lib/services/repost-text-cleanup";
import { hasAnyCarouselRow } from "@/lib/services/media-introspection";
import { resolveCleanSourceMedia } from "@/lib/services/clean-media-resolver";
import { isVideoBearingPostType } from "@/lib/platform-media-rules";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { checkRepostReadiness } from "@/lib/services/descript-derivative";
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
  "threads",
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
    manual?: unknown;
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
  // Operator escape: create the repost row but skip the readiness gate.
  // Surfaced via the "I'll do it manually" button when opportunistic
  // enrichment couldn't recover the source's media. seedRepostContent
  // handles the no-media case by mirroring whatever is there (often
  // nothing) — the operator attaches media from the workflow board.
  const manual = body.manual === true;

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
  // If a clean original is resolvable up the lineage (our Descript export /
  // upload), we'll seed THAT — so don't download the watermarked TikTok video.
  const hasCleanOriginal =
    (await resolveCleanSourceMedia(source.id)).kind === "archived";
  const sourceNeedsMedia =
    !hasCleanOriginal &&
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
      // Silent enrichment failure here is exactly what we want to surface
      // — the operator falls back to the manual path, but we need to see
      // why media archiving keeps missing so we can fix the source side.
      console.error(
        `[repost] enrichment failed for source ${source.id}:`,
        err instanceof Error ? err.message : err,
      );
      Sentry.captureException(err, {
        tags: { source: "repost-route", phase: "enrichment" },
        extra: {
          sourceItemId: source.id,
          postType: source.postType,
          accountId: source.accountId,
          withMedia: sourceNeedsMedia,
        },
      });
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

  // Hard gate: repost is same-platform / same-aspect, so it never needs
  // the pillar's uncropped pixels — the source's own (already-cropped)
  // media is the right material to re-air. The pre-gate enrichment step
  // above force-archives `mediaS3Key` for video-bearing posts, so this
  // gate is almost always already-OK by the time it runs; the refusal
  // path only fires when even the source can't be archived. Skipped when
  // `manual: true` — the operator has opted to bypass the automation.
  //
  // Re-query carousel state post-enrichment so image-only sources (X
  // tweet with 2 photos, IG carousel) pass the gate — those store all
  // their media in production_item_media rows, not on the legacy
  // mediaS3Key column, and seedRepostContent mirrors carousels natively.
  if (!manual) {
    const hasCarouselMedia = await hasAnyCarouselRow(source.id);
    const readiness = checkRepostReadiness(source, hasCarouselMedia);
    // A resolvable clean original (e.g. a Descript-export ancestor) counts as
    // ready even when the source's own media is absent.
    if (!readiness.ok && !hasCleanOriginal) {
      // Surface the residual "tried to enrich and still no media" case so
      // we can fix the silent media-archiving failure behind the scenes.
      // The operator still gets a recoverable response — the dialog
      // renders the "I'll do it manually" affordance off `reason`.
      Sentry.captureMessage(
        `[repost] readiness gate refused after opportunistic enrichment (${readiness.reason})`,
        {
          level: "warning",
          tags: { source: "repost-route", phase: "gate-refused" },
          extra: {
            sourceItemId: source.id,
            postType: source.postType,
            accountId: source.accountId,
            reason: readiness.reason,
            detail: readiness.detail,
          },
        },
      );
      return NextResponse.json(
        {
          error:
            "We couldn't auto-pull the source's media. Click \"I'll do it manually\" to create the row and upload it yourself.",
          reason: readiness.reason,
          detail: readiness.detail,
        },
        { status: 400 },
      );
    }
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

  // Clean the source body BEFORE opening the transaction — the LLM call
  // takes a few hundred ms and we don't want to hold a Postgres
  // transaction open across a network round-trip. Strips a leading date-
  // anchored opener ("8 years ago today:" etc.) so reposted-from-repost
  // bodies don't carry stale dated leads. Fail-soft.
  const seededBody = SEEDED_POST_TYPES.has(source.postType as PostType)
    ? await stripDateOpenerWithLLM(source.contentBody)
    : source.contentBody;

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
        sourceContentBody: seededBody,
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

  // Underlord auto-fire intentionally removed (2026-05-18). Same change as
  // the cross-post route: repost used to enqueue `descript-derivative-create`
  // which fires Underlord ($3.50/call). The operator gets a row with the
  // source's MP4 mirrored via `seedRepostContent` and can invoke Underlord
  // explicitly from the new row's detail page if they want a fresh Descript
  // composition.

  invalidateReportCaches();
  return NextResponse.json({ id: created.id }, { status: 201 });
}
