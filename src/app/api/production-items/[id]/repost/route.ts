import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { buildRepostValues } from "@/lib/services/repost-values";
import { seedRepostContent } from "@/lib/services/repost-seed";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import type { PostType } from "@/lib/platform-field-schemas";

// Platforms whose new repost rows get seeded with mirrored media + a v1
// content_drafts row at creation time. Other platforms still create the
// production_items row but skip seeding until they're wired up.
const SEEDED_POST_TYPES: ReadonlySet<PostType> = new Set<PostType>([
  "x",
  "instagram_post",
  "instagram_reel",
  "instagram_story",
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
  // the user explicitly wants to block on this. Failures (no published
  // link, broken upstream, etc.) are logged and we proceed; the repost
  // ends up no worse than today. `enrichSingleItem` is a no-op when
  // `enrichmentCompletedAt` is already set, so this is safe to always
  // call (cheap idempotent guard).
  if (!source.enrichmentCompletedAt) {
    try {
      await enrichSingleItem(source.id);
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

  // Don't carry a stale `format` from the source — if it doesn't exist in
  // the brand's formats table, set null instead of propagating the drift.
  const formatCheck = await normalizeFormatForWrite(source.brand, source.format);
  const inheritedFormat = formatCheck.ok ? formatCheck.value : null;

  const assignees = await resolveAssignees({
    brand: source.brand,
    sourceItemId: source.id,
    format: inheritedFormat,
  });
  const editorUserId = requestedEditorUserId ?? assignees.editorUserId;

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
      producerUserId: assignees.producerUserId,
      editorUserId,
    }
  );

  // One transaction so we never leave a half-seeded repost. The seed step
  // is sub-50ms (≤4 small INSERTs), invisible next to the redirect.
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(productionItems)
      .values({ ...baseValues, status: requestedStatus })
      .returning({ id: productionItems.id });

    if (SEEDED_POST_TYPES.has(source.postType as PostType)) {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: row.id,
        postType: source.postType as PostType,
        sourceContentBody: source.contentBody,
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

  return NextResponse.json({ id: created.id }, { status: 201 });
}
