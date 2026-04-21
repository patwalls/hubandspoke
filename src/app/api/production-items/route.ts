import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { db } from "@/lib/db";
import { contentEvents, productionItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { estimateViewsFromLikes, shouldEstimate } from "@/lib/services/view-estimator";
import { enqueueNotification } from "@/lib/services/notifications";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritative } from "@/lib/platform";

function getNotion(): Client {
  const auth = process.env.NOTION_API_SECRET;
  if (!auth) throw new Error("NOTION_API_SECRET not set");
  return new Client({ auth });
}

async function pushStatusToNotion(
  notionId: string,
  status: string
): Promise<void> {
  await getNotion().pages.update({
    page_id: notionId,
    properties: {
      Status: { select: { name: status } },
    },
  });
}

async function pushPillarToNotion(
  notionId: string,
  pillarNotionId: string | null
): Promise<void> {
  await getNotion().pages.update({
    page_id: notionId,
    properties: {
      "Pillar Content": {
        relation: pillarNotionId ? [{ id: pillarNotionId }] : [],
      },
    },
  });
}

/**
 * POST /api/production-items
 *
 * Manually create a production item (for platforms the API can't pull from).
 * If the published link is a YouTube URL, auto-fetches metrics.
 *
 * Body: {
 *   title: string
 *   platform: string[]
 *   format?: string
 *   publishedLink?: string
 *   publishedDate: string (YYYY-MM-DD)
 *   brand: string
 *   views?: number
 *   likes?: number
 *   comments?: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      platform,
      format,
      publishedLink,
      publishedDate,
      brand,
      views,
      likes,
      comments,
    } = body;

    if (!title || !platform?.length || !publishedDate || !brand) {
      return NextResponse.json(
        { error: "title, platform, publishedDate, and brand are required" },
        { status: 400 }
      );
    }

    let finalViews = views ?? null;
    let finalLikes = likes ?? null;
    let finalComments = comments ?? null;
    let finalViewsEstimated = false;
    let thumbnail: string | null = null;
    let youtubeId: string | null = null;
    let youtubeUrl: string | null = null;
    let autoFetched = false;

    // Auto-fetch metrics for YouTube URLs
    const isYouTube =
      publishedLink &&
      (publishedLink.includes("youtube.com") ||
        publishedLink.includes("youtu.be"));

    if (isYouTube) {
      try {
        const { fetchSingleVideo } = await import(
          "@/lib/services/matg-sync"
        );
        const video = await fetchSingleVideo(publishedLink);
        finalViews = video.viewCountInt;
        finalLikes = video.likeCountInt;
        finalComments = video.commentCountInt;
        thumbnail = video.thumbnail || null;
        youtubeId = video.id;
        youtubeUrl = video.url;
        autoFetched = true;
      } catch (err) {
        console.warn("Auto-fetch failed for YouTube URL, using manual values:", err);
      }
    } else if (platform && shouldEstimate(platform) && finalLikes && !finalViews) {
      // Estimate views from likes for platforms without real view data
      const estimation = estimateViewsFromLikes(platform, finalLikes);
      if (estimation.estimated) {
        finalViews = estimation.views;
        finalViewsEstimated = true;
      }
    }

    const bodyProducerUserId =
      typeof body.producerUserId === "string" ? body.producerUserId : null;
    const bodyEditorUserId =
      typeof body.editorUserId === "string" ? body.editorUserId : null;
    const resolved = await resolveAssignees({
      brand,
      format: format || null,
    });
    const producerUserId = bodyProducerUserId ?? resolved.producerUserId;
    const editorUserId = bodyEditorUserId ?? resolved.editorUserId;

    const [created] = await db
      .insert(productionItems)
      .values({
        title,
        platform,
        format: format || null,
        publishedLink: publishedLink || null,
        publishedDate,
        brand,
        status: "Published",
        views: finalViews,
        likes: finalLikes,
        comments: finalComments,
        viewsEstimated: finalViewsEstimated,
        thumbnail,
        youtubeId,
        youtubeUrl,
        isExternal: false,
        producerUserId,
        editorUserId,
        lastPerformanceSyncAt: autoFetched ? new Date() : null,
      })
      .returning();

    return NextResponse.json({ ...created, autoFetched }, { status: 201 });
  } catch (error) {
    console.error("Error creating production item:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/production-items
 *
 * Update an existing production item.
 * Body: { id: string, ...fields to update }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      id,
      title,
      platform,
      format,
      publishedLink,
      publishedDate,
      status,
      pillarContentItemId,
      producerUserId,
      editorUserId,
      views,
      likes,
      comments,
      clicks,
      leads,
      salesAmount,
      sourceType,
      killReason,
    } = body;

    const VALID_SOURCE_TYPES = new Set(["original", "repost", "cross_post"]);
    if (sourceType !== undefined && !VALID_SOURCE_TYPES.has(sourceType)) {
      return NextResponse.json(
        { error: `sourceType must be one of: ${[...VALID_SOURCE_TYPES].join(", ")}` },
        { status: 400 }
      );
    }

    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (title !== undefined) updateData.title = title;
    if (platform !== undefined) updateData.platform = platform;
    if (format !== undefined) updateData.format = format || null;
    if (publishedLink !== undefined) updateData.publishedLink = publishedLink || null;
    if (publishedDate !== undefined) updateData.publishedDate = publishedDate;
    if (status !== undefined) updateData.status = status || null;

    // Pillar: accept itemId (or null to clear). Resolve target's notionId so we
    // keep both foreign keys in sync, and so we can push the relation to Notion.
    let resolvedPillarNotionId: string | null | undefined = undefined;
    if (pillarContentItemId !== undefined) {
      if (pillarContentItemId) {
        const [target] = await db
          .select({ notionId: productionItems.notionId })
          .from(productionItems)
          .where(eq(productionItems.id, pillarContentItemId))
          .limit(1);
        if (!target) {
          return NextResponse.json(
            { error: "Pillar target not found" },
            { status: 400 }
          );
        }
        updateData.pillarContentItemId = pillarContentItemId;
        updateData.pillarContentNotionId = target.notionId;
        resolvedPillarNotionId = target.notionId;
      } else {
        updateData.pillarContentItemId = null;
        updateData.pillarContentNotionId = null;
        resolvedPillarNotionId = null;
      }
    }

    if (comments !== undefined) updateData.comments = comments === "" || comments === null ? null : Number(comments);
    if (clicks !== undefined) updateData.clicks = clicks === "" || clicks === null ? null : Number(clicks);
    if (leads !== undefined) updateData.leads = leads === "" || leads === null ? null : Number(leads);
    if (salesAmount !== undefined) updateData.salesAmount = salesAmount === "" || salesAmount === null ? null : String(salesAmount);

    // Source type: original → repost/cross_post mirrors pillar into
    // reposted_from_item_id if the latter is empty (matches the backfill
    // classifier's semantic). Flipping back to original clears it so the
    // repost graph stays clean.
    if (sourceType !== undefined) {
      updateData.sourceType = sourceType;
      const [existing] = await db
        .select({
          pillarContentItemId: productionItems.pillarContentItemId,
          repostedFromItemId: productionItems.repostedFromItemId,
        })
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      if (sourceType === "original") {
        updateData.repostedFromItemId = null;
      } else if (existing && !existing.repostedFromItemId) {
        const nextPillar =
          pillarContentItemId !== undefined
            ? pillarContentItemId
            : existing.pillarContentItemId;
        if (nextPillar) updateData.repostedFromItemId = nextPillar;
      }
    }

    // If status is changing, capture from/to so we can write a content_events row.
    // Fetched before the UPDATE so the diff is accurate.
    let statusTransition: { from: string | null; to: string | null } | null = null;
    if (status !== undefined) {
      const [existing] = await db
        .select({ status: productionItems.status })
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      const nextStatus: string | null = status || null;
      if (existing && existing.status !== nextStatus) {
        statusTransition = { from: existing.status, to: nextStatus };
      }
    }

    // Capture assignment diffs before the UPDATE so we can fire a notification
    // for each new assignee after the write commits. Producer/editor are
    // NOT NULL at the DB level — reject explicit attempts to clear them.
    let assignmentDiff: {
      producerChanged: boolean;
      editorChanged: boolean;
      nextProducerUserId: string;
      nextEditorUserId: string;
    } | null = null;
    if (producerUserId !== undefined || editorUserId !== undefined) {
      if (
        producerUserId !== undefined &&
        (producerUserId === null || producerUserId === "")
      ) {
        return NextResponse.json(
          { error: "producerUserId cannot be empty — every item needs a producer" },
          { status: 400 }
        );
      }
      if (
        editorUserId !== undefined &&
        (editorUserId === null || editorUserId === "")
      ) {
        return NextResponse.json(
          { error: "editorUserId cannot be empty — every item needs an editor" },
          { status: 400 }
        );
      }

      const [existing] = await db
        .select({
          producerUserId: productionItems.producerUserId,
          editorUserId: productionItems.editorUserId,
        })
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      if (!existing) {
        return NextResponse.json({ error: "Item not found" }, { status: 404 });
      }
      const nextProducer: string =
        producerUserId === undefined ? existing.producerUserId : producerUserId;
      const nextEditor: string =
        editorUserId === undefined ? existing.editorUserId : editorUserId;
      if (producerUserId !== undefined) {
        updateData.producerUserId = nextProducer;
      }
      if (editorUserId !== undefined) {
        updateData.editorUserId = nextEditor;
      }
      assignmentDiff = {
        producerChanged:
          producerUserId !== undefined && existing.producerUserId !== nextProducer,
        editorChanged:
          editorUserId !== undefined && existing.editorUserId !== nextEditor,
        nextProducerUserId: nextProducer,
        nextEditorUserId: nextEditor,
      };
    }

    // Handle views + likes together so estimation stays in sync
    const incomingViews = views !== undefined ? (views === "" || views === null ? null : Number(views)) : undefined;
    const incomingLikes = likes !== undefined ? (likes === "" || likes === null ? null : Number(likes)) : undefined;

    if (incomingViews !== undefined) {
      // User explicitly set views — treat as real, not estimated
      updateData.views = incomingViews;
      updateData.viewsEstimated = false;
    }

    if (incomingLikes !== undefined) {
      updateData.likes = incomingLikes;
      // Re-estimate views from new likes value if: no explicit views provided, platform uses estimation
      if (incomingViews === undefined && platform && shouldEstimate(platform) && incomingLikes && incomingLikes > 0) {
        const estimation = estimateViewsFromLikes(platform, incomingLikes);
        if (estimation.estimated) {
          updateData.views = estimation.views;
          updateData.viewsEstimated = true;
        }
      }
    }

    const session = await auth();
    const actorUserId = session?.user?.id ?? null;

    // Normalize kill reason: trim, empty → null, cap length. Only meaningful
    // when this PUT is flipping status to Killed; otherwise it's silently ignored.
    const normalizedKillReason: string | null = (() => {
      if (typeof killReason !== "string") return null;
      const trimmed = killReason.trim();
      if (!trimmed) return null;
      return trimmed.slice(0, 2000);
    })();

    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(productionItems)
        .set(updateData)
        .where(eq(productionItems.id, id))
        .returning();
      if (row && statusTransition) {
        if (statusTransition.to === "Killed") {
          await tx.insert(contentEvents).values({
            contentItemId: id,
            userId: actorUserId,
            eventType: "killed",
            payload: {
              type: "killed",
              from: statusTransition.from,
              reason: normalizedKillReason,
            },
          });
        } else {
          await tx.insert(contentEvents).values({
            contentItemId: id,
            userId: actorUserId,
            eventType: "status_change",
            payload: { type: "status_change", ...statusTransition },
          });
        }
      }
      return [row];
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    const warnings: string[] = [];
    // Only long-form YouTube pillars stay in sync with Notion. Shorts,
    // Community, IG, LinkedIn, etc. are H&S-owned — a stale notionId on those
    // rows (from pre-migration syncs) stays as a historical pointer but we no
    // longer round-trip edits to it.
    if (updated.notionId && isNotionAuthoritative(updated.platform)) {
      if (status !== undefined && status) {
        try {
          await pushStatusToNotion(updated.notionId, status);
        } catch (err) {
          console.error("Failed to push status to Notion:", err);
          warnings.push(
            `status: ${err instanceof Error ? err.message : "Notion update failed"}`
          );
        }
      }
      if (resolvedPillarNotionId !== undefined) {
        try {
          await pushPillarToNotion(updated.notionId, resolvedPillarNotionId);
        } catch (err) {
          console.error("Failed to push pillar to Notion:", err);
          warnings.push(
            `pillar: ${err instanceof Error ? err.message : "Notion update failed"}`
          );
        }
      }
    }

    // Fire assignment notifications after the write commits. Fire-and-forget —
    // email send is handled inside enqueueNotification and must not block the
    // save response.
    if (assignmentDiff) {
      if (assignmentDiff.producerChanged && assignmentDiff.nextProducerUserId) {
        void enqueueNotification({
          userId: assignmentDiff.nextProducerUserId,
          kind: "assigned",
          contentItemId: id,
          actorUserId: actorUserId,
          payload: {
            kind: "assigned",
            role: "producer",
            title: updated.title,
          },
        }).catch((err) =>
          console.error("[assignment] producer notify failed", err)
        );
      }
      if (assignmentDiff.editorChanged && assignmentDiff.nextEditorUserId) {
        void enqueueNotification({
          userId: assignmentDiff.nextEditorUserId,
          kind: "assigned",
          contentItemId: id,
          actorUserId: actorUserId,
          payload: {
            kind: "assigned",
            role: "editor",
            title: updated.title,
          },
        }).catch((err) =>
          console.error("[assignment] editor notify failed", err)
        );
      }
    }

    return NextResponse.json({
      ...updated,
      notionSyncWarning: warnings.length ? warnings.join("; ") : null,
    });
  } catch (error) {
    console.error("Error updating production item:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/production-items
 *
 * Delete a production item by id.
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }

    await db
      .delete(productionItems)
      .where(eq(productionItems.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting production item:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
