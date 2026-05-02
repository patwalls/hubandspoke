import { NextRequest, NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { db } from "@/lib/db";
import {
  contentEvents,
  crossPostDecisions,
  productionItems,
  users,
} from "@/lib/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { estimateViewsFromLikes, shouldEstimate } from "@/lib/services/view-estimator";
import {
  buildViewPredictorContext,
  predictViews,
} from "@/lib/services/view-predictor";
import { enqueueNotification } from "@/lib/services/notifications";
import { resolveAssignees } from "@/lib/services/assignees";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { findCrossAccountDuplicate } from "@/lib/services/production-items-dedup";
import { isNotionAuthoritative } from "@/lib/platform";
import { extractContentId } from "@/lib/platform-url";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { enqueue } from "@/jobs/enqueue";
import { scheduleVelocitySnapshots } from "@/jobs/tasks/capture-velocity-snapshot";

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

async function pushUtmCampaignToNotion(
  notionId: string,
  value: string | null
): Promise<void> {
  await getNotion().pages.update({
    page_id: notionId,
    properties: {
      utm_campaign: {
        rich_text: value ? [{ text: { content: value } }] : [],
      },
    },
  });
}

/**
 * POST /api/production-items
 *
 * Manually create a production item (for platforms the API can't pull from).
 * If the published link is a YouTube URL and no metrics are supplied, auto-
 * fetches them. The Add-from-link client flow pre-fetches via
 * /api/production-items/preview-link and POSTs the metrics directly —
 * we skip the second SC call in that case to save a credit.
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
 *   thumbnail?: string
 *   authorHandle?: string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      platform,
      accountId,
      postType,
      format,
      publishedLink,
      publishedDate,
      publishedAt: bodyPublishedAt,
      brand,
      views,
      likes,
      comments,
      thumbnail: bodyThumbnail,
      authorHandle: bodyAuthorHandle,
      utmCampaign: bodyUtmCampaign,
    } = body;

    if (!title || !platform?.length || !publishedDate || !brand) {
      return NextResponse.json(
        { error: "title, platform, publishedDate, and brand are required" },
        { status: 400 }
      );
    }

    const formatCheck = await normalizeFormatForWrite(brand, format);
    if (!formatCheck.ok) {
      return NextResponse.json({ error: formatCheck.error }, { status: 400 });
    }
    const validatedFormat = formatCheck.value;

    let finalViews = views ?? null;
    let finalLikes = likes ?? null;
    let finalComments = comments ?? null;
    let finalViewsEstimated = false;
    let thumbnail: string | null =
      typeof bodyThumbnail === "string" && bodyThumbnail ? bodyThumbnail : null;
    let youtubeId: string | null = null;
    let youtubeUrl: string | null = null;
    let autoFetched = false;

    // Auto-fetch metrics for YouTube URLs — but only when the caller didn't
    // already hand us metrics (e.g. via the preview-link flow). Skipping the
    // second fetch avoids burning an SC credit on every "Add from link" save.
    const isYouTube =
      publishedLink &&
      (publishedLink.includes("youtube.com") ||
        publishedLink.includes("youtu.be"));
    const clientSuppliedMetrics =
      views != null || likes != null || comments != null;

    if (isYouTube && !clientSuppliedMetrics) {
      const ytStart = Date.now();
      let ytOk = false;
      try {
        const { fetchSingleVideo } = await import(
          "@/lib/services/sc-fetchers"
        );
        const video = await fetchSingleVideo(publishedLink);
        finalViews = video.viewCountInt;
        finalLikes = video.likeCountInt;
        finalComments = video.commentCountInt;
        thumbnail = thumbnail ?? video.thumbnail ?? null;
        youtubeId = video.id;
        youtubeUrl = video.url;
        autoFetched = true;
        ytOk = true;
      } catch (err) {
        console.warn("Auto-fetch failed for YouTube URL, using manual values:", err);
      } finally {
        const { recordScUsage } = await import(
          "@/lib/services/sc-usage-log"
        );
        void recordScUsage({
          caller: "create-item-yt-fetch",
          platform: "youtube",
          credits: 1,
          ok: ytOk,
          notes: publishedLink.slice(0, 500),
          durationMs: Date.now() - ytStart,
        });
      }
    } else if (shouldEstimate(postType) && finalLikes && !finalViews) {
      // Estimate views from likes for post types without real view data
      const estimation = estimateViewsFromLikes(postType, finalLikes);
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
      format: validatedFormat,
    });
    const producerUserId = bodyProducerUserId ?? resolved.producerUserId;
    const editorUserId = bodyEditorUserId ?? resolved.editorUserId;

    const authorHandle: string | null =
      typeof bodyAuthorHandle === "string" && bodyAuthorHandle
        ? bodyAuthorHandle
        : null;

    // Stamp a sync time if either the server auto-fetched OR the client
    // hands us fresh metrics (preview-link flow already talked to SC).
    const lastPerformanceSyncAt =
      autoFetched || clientSuppliedMetrics ? new Date() : null;

    // Precise publish moment. Prefer the platform-reported timestamp (from
    // preview-link). Otherwise stamp now — new rows are created with
    // status = "Published", so "created at" is a good proxy.
    const publishedAt =
      typeof bodyPublishedAt === "string" && bodyPublishedAt
        ? new Date(bodyPublishedAt)
        : new Date();

    // Caller-supplied UTM (from the Add-Post dialog so operators can paste it
    // into the published link before saving) wins when present and non-empty;
    // otherwise we generate one. The partial unique index on `utm_campaign`
    // is still the source of truth for collision protection.
    const suppliedUtm =
      typeof bodyUtmCampaign === "string" ? bodyUtmCampaign.trim() : "";
    const utmCampaign = suppliedUtm || (await generateUtmCampaign(title));
    // Single dedup key for content sync — derive it from the URL whenever
    // possible. YouTube already extracts `youtubeId` above; reuse it so the
    // partial unique index `(account_id, platform_content_id)` catches
    // re-adds of the same post via a different URL shape (e.g. `?utm_source`,
    // `threads.com` vs `threads.net`).
    const platformContentId =
      youtubeId ?? extractContentId(postType, publishedLink) ?? null;

    // Cross-account duplicate guard. Surfaces the existing item id so the
    // client can deep-link the operator to it instead of creating a second
    // row that would double-count metrics. The DB unique index
    // `uniq_production_items_platform_content_id_global` is the safety net
    // for the race where two concurrent POSTs pass this check. Skipped when
    // platformContentId can't be extracted (LinkedIn, newsletter, ad-hoc
    // URLs) — see helper docs for why URL-based dedup is intentionally not
    // enforced.
    const duplicate = await findCrossAccountDuplicate({ platformContentId });
    if (duplicate) {
      return NextResponse.json(
        {
          error: "DUPLICATE_URL",
          message: `This URL is already tracked on @${duplicate.accountHandle ?? "another account"} — open that item instead.`,
          existingItemId: duplicate.id,
          existingAccountHandle: duplicate.accountHandle,
        },
        { status: 409 }
      );
    }

    const [created] = await db
      .insert(productionItems)
      .values({
        title,
        platform,
        accountId: accountId || null,
        postType: postType || null,
        format: validatedFormat,
        publishedLink: publishedLink || null,
        platformContentId,
        publishedDate,
        publishedAt,
        brand,
        status: "Published",
        utmCampaign,
        views: finalViews,
        likes: finalLikes,
        comments: finalComments,
        viewsEstimated: finalViewsEstimated,
        thumbnail,
        youtubeId,
        youtubeUrl,
        authorHandle,
        isExternal: false,
        producerUserId,
        editorUserId,
        lastPerformanceSyncAt,
      })
      .returning();

    // Kick off a platform-API metrics fetch for new items with a published
    // link — unless we already have fresh metrics from the preview-link flow
    // or the inline YouTube fetch. Saves waiting for the next hourly
    // `performance-decay` sweep on X/Instagram/LinkedIn/TikTok/Threads rows
    // that come in without pre-fetched metrics.
    const hasFreshMetrics = autoFetched || clientSuppliedMetrics;
    if (created.publishedLink && !hasFreshMetrics) {
      try {
        await enqueue(
          "refresh-item-metrics",
          { productionItemId: created.id },
          {
            jobKey: `refresh-item-metrics-${created.id}`,
            jobKeyMode: "unsafe_dedupe",
          }
        );
      } catch (err) {
        console.error("[create] refresh-item-metrics enqueue failed", err);
      }
    }

    // Schedule the 5 velocity-snapshot jobs so the cross-post scanner has
    // view-count checkpoints at 15m/30m/1h/2h/4h after publish. No-op when
    // the supplied publishedAt is already >4h old.
    try {
      await scheduleVelocitySnapshots(created.id, created.publishedAt);
    } catch (err) {
      console.error("[create] scheduleVelocitySnapshots failed", err);
    }

    return NextResponse.json({ ...created, autoFetched }, { status: 201 });
  } catch (error) {
    // 23505 = unique_violation. Catches the race where two concurrent POSTs
    // pass the pre-check above and only one commits. Translate to the same
    // 409 shape so the client gets a consistent error contract.
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    if (code === "23505") {
      return NextResponse.json(
        {
          error: "DUPLICATE_URL",
          message: "This URL is already tracked on another account — open that item instead.",
        },
        { status: 409 }
      );
    }
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
      accountId,
      postType,
      format,
      publishedLink,
      publishedDate,
      publishedAt: bodyPublishedAt,
      status,
      pillarContentItemId,
      repostedFromItemId,
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
      utmCampaign,
      shortLinkSlug,
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

    // Validate format references a real row in the brand's formats list
    // before doing anything else. Resolves the row's brand once for the
    // lookup; the cost is one extra SELECT only when the caller is
    // touching format.
    let validatedFormat: string | null | undefined = undefined;
    if (format !== undefined) {
      const [row] = await db
        .select({ brand: productionItems.brand })
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      if (!row) {
        return NextResponse.json(
          { error: "Item not found" },
          { status: 404 }
        );
      }
      const check = await normalizeFormatForWrite(row.brand, format);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
      validatedFormat = check.value;
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (title !== undefined) updateData.title = title;
    if (platform !== undefined) updateData.platform = platform;
    // Account/post_type are the new source of truth; the legacy `platform`
    // jsonb column is still written from the client for backward compat
    // until the finalize migration drops it.
    if (accountId !== undefined) updateData.accountId = accountId || null;
    if (postType !== undefined) updateData.postType = postType || null;
    if (format !== undefined) updateData.format = validatedFormat ?? null;
    if (publishedLink !== undefined) {
      updateData.publishedLink = publishedLink || null;
      // Re-derive platform_content_id whenever the URL changes so the
      // partial unique index `(account_id, platform_content_id)` keeps
      // catching duplicates even when manual entry differs in trailing
      // slash, query string, or domain (threads.com vs threads.net).
      let pt: string | null = typeof postType === "string" ? postType : null;
      if (postType === undefined) {
        const [existing] = await db
          .select({ postType: productionItems.postType })
          .from(productionItems)
          .where(eq(productionItems.id, id))
          .limit(1);
        pt = existing?.postType ?? null;
      }
      updateData.platformContentId =
        extractContentId(pt, publishedLink) ?? null;
    }
    if (publishedDate !== undefined) updateData.publishedDate = publishedDate;
    if (bodyPublishedAt !== undefined) {
      updateData.publishedAt =
        bodyPublishedAt === null ? null : new Date(bodyPublishedAt);
    }
    if (status !== undefined) updateData.status = status || null;
    if (utmCampaign !== undefined) {
      const trimmed = typeof utmCampaign === "string" ? utmCampaign.trim() : "";
      updateData.utmCampaign = trimmed || null;
    }
    if (shortLinkSlug !== undefined) {
      if (shortLinkSlug === null || shortLinkSlug === "") {
        updateData.shortLinkSlug = null;
      } else if (typeof shortLinkSlug === "string") {
        const normalized = shortLinkSlug.trim().toLowerCase();
        if (!/^[a-z0-9_-]+$/.test(normalized)) {
          return NextResponse.json(
            { error: "shortLinkSlug may only contain letters, numbers, hyphens, underscores" },
            { status: 400 },
          );
        }
        updateData.shortLinkSlug = normalized;
      }
    }

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

    // Explicit reposted-from override. Runs after the sourceType auto-mirror
    // so a user's pick from the detail-page picker wins over the default.
    if (repostedFromItemId !== undefined) {
      if (repostedFromItemId) {
        if (repostedFromItemId === id) {
          return NextResponse.json(
            { error: "Cannot repost from itself" },
            { status: 400 },
          );
        }
        const [target] = await db
          .select({ id: productionItems.id })
          .from(productionItems)
          .where(eq(productionItems.id, repostedFromItemId))
          .limit(1);
        if (!target) {
          return NextResponse.json(
            { error: "Reposted-from target not found" },
            { status: 400 },
          );
        }
        updateData.repostedFromItemId = repostedFromItemId;
      } else {
        updateData.repostedFromItemId = null;
      }
    }

    // If status is changing, capture from/to so we can write a content_events row.
    // Fetched before the UPDATE so the diff is accurate.
    let statusTransition: { from: string | null; to: string | null } | null = null;
    let publishedLinkAdded = false;
    if (status !== undefined || publishedLink !== undefined) {
      const [existing] = await db
        .select({
          status: productionItems.status,
          publishedLink: productionItems.publishedLink,
        })
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      if (existing && status !== undefined) {
        const nextStatus: string | null = status || null;
        if (existing.status !== nextStatus) {
          statusTransition = { from: existing.status, to: nextStatus };
        }
      }
      if (existing && publishedLink !== undefined) {
        const nextLink: string | null = publishedLink || null;
        if (!!nextLink && existing.publishedLink !== nextLink) {
          publishedLinkAdded = true;
        }
      }
    }

    // Snapshot the prediction the first time this item flips to Published so
    // we can render Predicted-vs-Actual afterwards. Never overwrite an existing
    // snapshot — a republish shouldn't erase the original call.
    if (statusTransition?.to === "Published") {
      const [current] = await db
        .select({
          brand: productionItems.brand,
          format: productionItems.format,
          platform: productionItems.platform,
          pillarContentItemId: productionItems.pillarContentItemId,
          predictedViewsSnapshot: productionItems.predictedViewsSnapshot,
          publishedAt: productionItems.publishedAt,
        })
        .from(productionItems)
        .where(eq(productionItems.id, id))
        .limit(1);
      // Stamp a precise publish moment the first time an item flips to
      // Published, so same-day sort tie-breaking reflects the order things
      // actually went live in-app. Don't clobber an existing value (platform
      // timestamp or explicit admin edit) on subsequent edits.
      if (
        current &&
        current.publishedAt == null &&
        updateData.publishedAt === undefined
      ) {
        updateData.publishedAt = new Date();
      }
      if (current && current.predictedViewsSnapshot == null) {
        const nextPlatform =
          platform !== undefined
            ? (platform as string[] | null)
            : ((current.platform as string[] | null) ?? null);
        const nextFormat =
          format !== undefined ? validatedFormat ?? null : current.format;
        const nextPillar =
          pillarContentItemId !== undefined
            ? pillarContentItemId || null
            : current.pillarContentItemId;
        try {
          const ctx = await buildViewPredictorContext(current.brand);
          const p = predictViews(
            {
              id,
              format: nextFormat,
              platforms: nextPlatform,
              pillarContentItemId: nextPillar,
            },
            ctx
          );
          if (p.prediction != null) {
            updateData.predictedViewsSnapshot = p.prediction;
            updateData.predictedViewsSnapshotAt = new Date();
          }
        } catch (err) {
          console.error(
            "[publish] predicted views snapshot failed — continuing publish anyway",
            err
          );
        }
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
    let editorChangeNames: { from: string | null; to: string | null } | null =
      null;
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

      if (assignmentDiff.editorChanged) {
        const ids = [existing.editorUserId, nextEditor];
        const rows = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, ids));
        const display = (u: (typeof rows)[number] | undefined): string | null => {
          if (!u) return null;
          if (u.name && u.name.trim()) return u.name;
          return u.email.split("@")[0] ?? u.email;
        };
        editorChangeNames = {
          from: display(rows.find((r) => r.id === existing.editorUserId)),
          to: display(rows.find((r) => r.id === nextEditor)),
        };
      }
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
      // Re-estimate views from new likes value if: no explicit views
      // provided, post type uses estimation
      if (incomingViews === undefined && shouldEstimate(postType) && incomingLikes && incomingLikes > 0) {
        const estimation = estimateViewsFromLikes(postType, incomingLikes);
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

    // A reason is required whenever we transition to Killed. Kill reasons feed
    // the evergreen classifier as negative exemplars — null reasons break the
    // feedback loop.
    if (
      statusTransition?.to === "Killed" &&
      (!normalizedKillReason || normalizedKillReason.length < 10)
    ) {
      return NextResponse.json(
        { error: "A kill reason of at least 10 characters is required" },
        { status: 400 }
      );
    }

    // Cross-account duplicate guard for the publishedLink change. Mirrors
    // the POST-side check; the DB unique index is the safety net for races.
    // Only runs when the URL is actually changing AND we managed to extract
    // a platform-native id from it.
    if (
      publishedLink !== undefined &&
      typeof publishedLink === "string" &&
      publishedLink.trim() !== "" &&
      updateData.platformContentId
    ) {
      const duplicate = await findCrossAccountDuplicate({
        platformContentId: updateData.platformContentId as string,
        excludeId: id,
      });
      if (duplicate) {
        return NextResponse.json(
          {
            error: "DUPLICATE_URL",
            message: `This URL is already tracked on @${duplicate.accountHandle ?? "another account"} — open that item instead.`,
            existingItemId: duplicate.id,
            existingAccountHandle: duplicate.accountHandle,
          },
          { status: 409 }
        );
      }
    }

    let updated: typeof productionItems.$inferSelect | undefined;
    try {
      [updated] = await db.transaction(async (tx) => {
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
            // Mirror the kill onto the cross_post_decisions row (if any) so
            // the LLM feedback loop sees this kill regardless of which
            // endpoint issued it.
            if (row.sourceType === "cross_post") {
              await tx
                .update(crossPostDecisions)
                .set({
                  outcome: "killed",
                  outcomeReason: normalizedKillReason,
                  outcomeAt: new Date(),
                })
                .where(
                  and(
                    eq(crossPostDecisions.ideaItemId, id),
                    isNull(crossPostDecisions.outcome)
                  )
                );
            }
          } else {
            await tx.insert(contentEvents).values({
              contentItemId: id,
              userId: actorUserId,
              eventType: "status_change",
              payload: { type: "status_change", ...statusTransition },
            });
          }
        }
        if (row && editorChangeNames) {
          await tx.insert(contentEvents).values({
            contentItemId: id,
            userId: actorUserId,
            eventType: "editor_change",
            payload: {
              type: "editor_change",
              from: editorChangeNames.from,
              to: editorChangeNames.to,
            },
          });
        }
        return [row];
      });
    } catch (err) {
      // 23505 = unique_violation. Multiple PUT-reachable unique constraints —
      // discriminate on the constraint name so the client gets a useful
      // message instead of the wrong one.
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : null;
      const constraint =
        err && typeof err === "object" && "constraint" in err
          ? String((err as { constraint: unknown }).constraint)
          : null;
      if (code === "23505") {
        if (
          constraint === "uniq_production_items_platform_content_id_global" ||
          constraint === "uniq_production_items_account_platform_content_id"
        ) {
          return NextResponse.json(
            {
              error: "DUPLICATE_URL",
              message:
                "This URL is already tracked on another item — open that item instead.",
            },
            { status: 409 }
          );
        }
        if (constraint === "uniq_production_items_utm_campaign") {
          return NextResponse.json(
            { error: "That CTA UTM campaign is already taken" },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: "Unique constraint violation", constraint },
          { status: 409 }
        );
      }
      throw err;
    }

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
    if (updated.notionId && isNotionAuthoritative(updated.postType)) {
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
      if (utmCampaign !== undefined) {
        try {
          await pushUtmCampaignToNotion(
            updated.notionId,
            updated.utmCampaign ?? null
          );
        } catch (err) {
          console.error("Failed to push utm_campaign to Notion:", err);
          warnings.push(
            `utm_campaign: ${err instanceof Error ? err.message : "Notion update failed"}`
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

    // Kick off a platform-API metrics fetch when the row has just become
    // Published with a link, OR when the published link was freshly added/
    // changed on an already-Published row. Title/producer/clicks edits
    // don't trigger — those don't change what the metrics pull would return.
    const publishedNow =
      statusTransition?.to === "Published" && !!updated.publishedLink;
    const linkChangedOnPublished =
      publishedLinkAdded && updated.status === "Published";
    if (publishedNow || linkChangedOnPublished) {
      try {
        await enqueue(
          "refresh-item-metrics",
          { productionItemId: updated.id },
          {
            jobKey: `refresh-item-metrics-${updated.id}`,
            jobKeyMode: "unsafe_dedupe",
          }
        );
      } catch (err) {
        console.error("[update] refresh-item-metrics enqueue failed", err);
      }
    }

    // Catch the common operator flow: post on-platform, flip this Idea to
    // Published in-app, paste the link. If the operator is marking at the
    // real moment of posting (the typical case), `publishedAt` is accurate
    // and the 5 velocity snapshots fire at the right ages. If they mark
    // late, the capture-velocity-snapshot task's per-checkpoint window
    // check skips out-of-window jobs — no misleading data. If
    // account-content-sync later observes the same item with the real SC
    // publish time, graphile-worker's default `jobKeyMode: "replace"` on
    // the shared `velocity-{id}-{cp}` jobKey updates the `run_at` of any
    // still-pending checkpoints to the corrected time.
    if (publishedNow || linkChangedOnPublished) {
      try {
        await scheduleVelocitySnapshots(updated.id, updated.publishedAt);
      } catch (err) {
        console.error("[update] scheduleVelocitySnapshots failed", err);
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
