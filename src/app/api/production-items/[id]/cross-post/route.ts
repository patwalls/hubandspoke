import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { accounts, contentEvents, productionItems, users } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { hasAnyCarouselRow } from "@/lib/services/media-introspection";
import { isVideoBearingPostType } from "@/lib/platform-media-rules";
import { seedRepostContent } from "@/lib/services/repost-seed";
import { enqueue } from "@/jobs/enqueue";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { isNotionAuthoritative } from "@/lib/platform";
import type { PostType } from "@/lib/platform-field-schemas";

// Cross-post targets that get the same media-mirror + draft-seed treatment
// as reposts. Without this the simulator on the redirect page lands in
// "Read-only — no draft yet" state, which means no Add-photo button, no
// inline editing, no AI caption regenerate. Mirror this set with the
// SEEDED_POST_TYPES in the repost route — they share the same UX promise.
const CROSS_POST_SEEDED_TARGETS: ReadonlySet<PostType> = new Set<PostType>([
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

/**
 * POST /api/production-items/[id]/cross-post
 *
 * Body:
 *   { targetAccountId: string,
 *     targetPostType?: string | null,
 *     assign?: boolean,
 *     editorUserId?: string | null }
 *
 * Creates a new `cross_post` production item from the source item for the
 * given target account. Inherits title, thumbnail, format, pillar, and brand
 * from the source. Returns the new item id so the client can redirect to
 * the detail page.
 *
 * Status semantics:
 *   - default (no `assign`, no `editorUserId`) → status = "Idea". Used by
 *     the per-item Cross-post submenu on `/content/[id]`.
 *   - `assign: true` and/or `editorUserId` provided → status = "Ready To
 *     Publish". `editorUserId` overrides `resolveAssignees`'s pick. Used
 *     by the cross-post queue modal so "Cross-post to @handle" lands the
 *     item ready for publish in a single round-trip — cross-posts have no
 *     editorial work to do, so skipping the Assigned/Review/etc. middle
 *     statuses is intentional.
 *
 * On status='Ready To Publish' inserts, also writes a `cross_post_created`
 * activity event so the new row's content-detail page shows where it came
 * from + a link back to the source.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 }
    );
  }

  const targetAccountId =
    typeof (body as { targetAccountId?: unknown }).targetAccountId === "string"
      ? (body as { targetAccountId: string }).targetAccountId.trim()
      : "";
  const targetPostTypeRaw = (body as { targetPostType?: unknown }).targetPostType;
  const targetPostType =
    typeof targetPostTypeRaw === "string" && targetPostTypeRaw.trim().length > 0
      ? targetPostTypeRaw.trim()
      : null;
  const editorUserIdRaw = (body as { editorUserId?: unknown }).editorUserId;
  const editorUserIdOverride =
    typeof editorUserIdRaw === "string" && editorUserIdRaw.trim().length > 0
      ? editorUserIdRaw.trim()
      : null;
  const assign = (body as { assign?: unknown }).assign === true;

  if (!targetAccountId) {
    return NextResponse.json(
      { error: "targetAccountId is required" },
      { status: 400 }
    );
  }

  const [target] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, targetAccountId))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: "Target account not found" }, { status: 404 });
  }

  // Per-post-type Notion check, not per-account: a Notion-synced YouTube
  // channel still accepts youtube_shorts / youtube_community cross-posts —
  // only youtube_long is owned by Notion and must be created there.
  if (targetPostType && isNotionAuthoritative(targetPostType)) {
    return NextResponse.json(
      {
        error:
          "Target post type is Notion-authoritative; create that post in Notion instead.",
      },
      { status: 400 }
    );
  }

  let [source] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json({ error: "Source item not found" }, { status: 404 });
  }

  // Best-effort: enrich the source first. Two firing conditions, identical
  // to the repost route:
  //   1. Source has never been enriched (`enrichmentCompletedAt` null).
  //   2. Source is enriched but a video-bearing post type with no archived
  //      video (no carousel rows AND no legacy `mediaS3Key`). Force a
  //      `withMedia: true` re-enrichment so the cross-post doesn't ship
  //      with an empty media slot. See repost/route.ts for the full
  //      cost-model rationale.
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
        `[cross-post] enrichment failed for source ${source.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (source.accountId === targetAccountId && source.postType === targetPostType) {
    return NextResponse.json(
      { error: "Source is already on the target account" },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "cross_post"),
        eq(productionItems.repostedFromItemId, source.id),
        eq(productionItems.accountId, targetAccountId)
      )
    )
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: "A cross-post for this target account already exists", existingId: existing.id },
      { status: 409 }
    );
  }

  // Don't propagate a stale `format` from the source — if the source row
  // points at a format name that no longer exists in the brand's formats
  // table (legacy auto-default like "Tweet"), drop to null instead of
  // carrying the drift forward.
  const formatCheck = await normalizeFormatForWrite(source.brand, source.format);
  const inheritedFormat = formatCheck.ok ? formatCheck.value : null;

  const assignees = await resolveAssignees({
    brand: source.brand,
    sourceItemId: source.id,
    format: inheritedFormat,
  });

  const editorUserId = editorUserIdOverride ?? assignees.editorUserId;
  // Cross-posts skip the editorial pipeline (Assigned → Review → Ready)
  // because there's no work to do — same content, different channel. Land
  // queue-driven creates straight in "Ready To Publish". Every brand has
  // this status seeded in brand_statuses, so the literal is safe.
  const isQueueDriven = assign || !!editorUserIdOverride;
  const status = isQueueDriven ? "Ready To Publish" : "Idea";

  // Wrap the insert + seed in a transaction so a partial failure (e.g.
  // mid-mirror media insert) doesn't leave a half-created cross-post.
  const utm = await generateUtmCampaign(source.title);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(productionItems)
      .values({
        brand: source.brand,
        title: source.title,
        thumbnail: source.thumbnail,
        status,
        accountId: targetAccountId,
        postType: targetPostType,
        sourceType: "cross_post",
        repostedFromItemId: source.id,
        format: inheritedFormat,
        pillarContentNotionId: source.pillarContentNotionId,
        pillarContentItemId: source.pillarContentItemId,
        utmCampaign: utm,
        producerUserId: assignees.producerUserId,
        editorUserId,
      })
      .returning({ id: productionItems.id });

    // Seed mirrored media + a v1 contentDrafts row so the simulator on the
    // redirect page lands editable — same UX promise as the repost route.
    // Without this the new cross-post shows "Read-only — no draft yet."
    // and the Add-photo / Generate-caption / inline-edit affordances are
    // all hidden because they gate on `editable = draftId !== null`.
    if (CROSS_POST_SEEDED_TARGETS.has(targetPostType as PostType)) {
      await seedRepostContent(tx, {
        sourceId: source.id,
        repostId: row.id,
        postType: targetPostType as PostType,
        sourceContentBody: source.contentBody,
        sourceLegacyMedia: source.mediaS3Key
          ? {
              s3Bucket: source.mediaS3Bucket,
              s3Key: source.mediaS3Key,
              contentType: source.mediaContentType,
              posterS3Key: source.posterS3Key,
            }
          : null,
        actorUserId: guard.session.user.id,
      });
    }

    return row;
  });

  // Activity trail on the new row so the editor lands on the detail page
  // and immediately sees where this came from. Only stamped on queue-
  // driven creates — drive-by cross-posts from the per-item submenu don't
  // have a meaningful "came from" beyond the source pointer already on
  // the row.
  if (isQueueDriven) {
    await db.insert(contentEvents).values({
      contentItemId: created.id,
      userId: guard.session.user.id,
      eventType: "cross_post_created",
      payload: {
        type: "cross_post_created",
        sourceItemId: source.id,
        sourceTitle: source.title,
        targetAccountHandle: target.handle,
        targetPostType,
      },
    });

    // Second event: log the editor assignment so the activity feed reads
    // "Pat Walls added <editor> as the editor" alongside the create event.
    // Mirrors the editor_change convention used by PUT /production-items —
    // payload stores display names (not IDs).
    if (editorUserId) {
      const [editor] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, editorUserId))
        .limit(1);
      if (editor) {
        const editorName =
          editor.name?.trim() || editor.email.split("@")[0] || editor.email;
        await db.insert(contentEvents).values({
          contentItemId: created.id,
          userId: guard.session.user.id,
          eventType: "editor_change",
          payload: {
            type: "editor_change",
            from: null,
            to: editorName,
          },
        });
      }
    }
  }

  // After the seed tx commits, fire the Draft Algorithm. The algorithm
  // skips internally for unsupported post types (e.g. youtube_long,
  // newsletter), so we can enqueue unconditionally for any seeded target.
  // Fire-and-forget; failure here doesn't block the redirect to the new
  // item.
  if (CROSS_POST_SEEDED_TARGETS.has(targetPostType as PostType)) {
    try {
      await enqueue("draft-algorithm-run", {
        productionItemId: created.id,
      });
    } catch (err) {
      console.error("draft-algorithm-run enqueue (cross-post) failed:", err);
    }
  }

  return NextResponse.json({ id: created.id }, { status: 201 });
}
