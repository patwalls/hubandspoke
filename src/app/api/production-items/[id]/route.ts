import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  contentDrafts,
  crossPostDecisions,
  productionItemMedia,
  productionItems,
  formats,
  transcripts,
  users,
  viewSnapshots,
} from "@/lib/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  buildViewPredictorContext,
  predictViews,
  type ViewPrediction,
} from "@/lib/services/view-predictor";
import { resolveSchemaForPlatforms } from "@/lib/platform-field-schemas";
import { getPresignedGetUrl } from "@/lib/s3";
import { getChannelsForFormats } from "@/lib/format-channels";
import { checkRepostReadiness } from "@/lib/services/descript-derivative";
import { hasAnyCarouselRow } from "@/lib/services/media-introspection";
import {
  classifyMediaSource,
  resolveCleanSourceMedia,
} from "@/lib/services/clean-media-resolver";

const POSTER_URL_TTL_SECONDS = 60 * 60;

async function presignOrNull(
  key: string | null,
  bucket?: string,
): Promise<string | null> {
  if (!key) return null;
  try {
    return await getPresignedGetUrl(key, POSTER_URL_TTL_SECONDS, { bucket });
  } catch {
    return null;
  }
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const [item] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, id))
      .limit(1);

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    // Derivatives: every production item whose Pillar Content chain leads
    // back to this item — direct children, grandchildren, and deeper.
    // BFS level by level; one query per depth. `visited` guards against
    // cycles. Each row is tagged with its depth (1 = direct child).
    type Derivative = typeof productionItems.$inferSelect & { depth: number };
    const derivatives: Derivative[] = [];
    const visited = new Set<string>([id]);
    let frontier: string[] = [id];
    let depth = 0;
    while (frontier.length > 0) {
      depth++;
      const children = await db
        .select()
        .from(productionItems)
        .where(inArray(productionItems.pillarContentItemId, frontier));
      const next: string[] = [];
      for (const c of children) {
        if (visited.has(c.id)) continue;
        visited.add(c.id);
        derivatives.push({ ...c, depth });
        next.push(c.id);
      }
      frontier = next;
    }
    // Direct children first, then grandchildren, then deeper. Within each
    // depth, most recently published first (nulls sort last).
    derivatives.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      const ad = a.publishedDate ?? "";
      const bd = b.publishedDate ?? "";
      if (!ad && bd) return 1;
      if (ad && !bd) return -1;
      return bd.localeCompare(ad);
    });
    const brandFormats = await db
      .select({
        id: formats.id,
        name: formats.name,
        parentFormatId: formats.parentFormatId,
        instructions: formats.instructions,
      })
      .from(formats)
      .where(eq(formats.brand, item.brand))
      .orderBy(formats.name);

    // Whether this item has a platform we can draft for — drives the
    // "Generate draft" button's enabled state. Lookup is by platform (where
    // the post lives), not format (the editorial template).
    const platformResolution = resolveSchemaForPlatforms(
      (item.platform as string[] | null) ?? null,
    );
    const hasFieldSchema = !!platformResolution.schema;

    let pillar: { id: string; title: string | null; format: string | null } | null = null;
    if (item.pillarContentItemId) {
      const [p] = await db
        .select({
          id: productionItems.id,
          title: productionItems.title,
          format: productionItems.format,
        })
        .from(productionItems)
        .where(eq(productionItems.id, item.pillarContentItemId))
        .limit(1);
      if (p) pillar = p;
    }

    // Reposts: other items whose repostedFromItemId points back at THIS item.
    // Used by the detail page to render the "Reposts" strip on originals, and
    // to show the source item on a repost. Mirrors the Derivative table's
    // columns so the two sections feel like siblings.
    const sourcedChildren = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        thumbnail: productionItems.thumbnail,
        posterS3Key: productionItems.posterS3Key,
        mediaS3Key: productionItems.mediaS3Key,
        mediaS3Bucket: productionItems.mediaS3Bucket,
        mediaContentType: productionItems.mediaContentType,
        status: productionItems.status,
        platform: productionItems.platform,
        postType: productionItems.postType,
        accountId: productionItems.accountId,
        publishedDate: productionItems.publishedDate,
        publishedLink: productionItems.publishedLink,
        views: productionItems.views,
        viewsEstimated: productionItems.viewsEstimated,
        likes: productionItems.likes,
        comments: productionItems.comments,
        sourceType: productionItems.sourceType,
        createdAt: productionItems.createdAt,
      })
      .from(productionItems)
      .where(eq(productionItems.repostedFromItemId, id))
      .orderBy(desc(productionItems.createdAt));

    const reposts = sourcedChildren.filter((r) => r.sourceType === "repost");
    const crossPosts = sourcedChildren.filter(
      (r) => r.sourceType === "cross_post"
    );

    // Views across every downstream piece of content: pillar-linked
    // derivatives, same-content reposts, and cross-platform syndications.
    // These are disjoint in practice (a row is linked via either
    // pillarContentItemId or repostedFromItemId, not both), so no dedupe.
    const descendantViewsTotal =
      derivatives.reduce((sum, d) => sum + (d.views ?? 0), 0) +
      reposts.reduce((sum, r) => sum + (r.views ?? 0), 0) +
      crossPosts.reduce((sum, c) => sum + (c.views ?? 0), 0);

    let repostedFrom:
      | {
          id: string;
          title: string | null;
          publishedDate: string | null;
          publishedLink: string | null;
          postType: string | null;
          account: {
            id: string;
            platform: string;
            handle: string;
            displayName: string | null;
          } | null;
          views: number | null;
          evergreenReasoning: string | null;
        }
      | null = null;
    if (
      (item.sourceType === "repost" || item.sourceType === "cross_post") &&
      item.repostedFromItemId
    ) {
      const [src] = await db
        .select({
          id: productionItems.id,
          title: productionItems.title,
          publishedDate: productionItems.publishedDate,
          publishedLink: productionItems.publishedLink,
          postType: productionItems.postType,
          views: productionItems.views,
          evergreenReasoning: productionItems.evergreenReasoning,
          accountId: accounts.id,
          accountPlatform: accounts.platform,
          accountHandle: accounts.handle,
          accountDisplayName: accounts.displayName,
        })
        .from(productionItems)
        .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
        .where(eq(productionItems.id, item.repostedFromItemId))
        .limit(1);
      if (src)
        repostedFrom = {
          id: src.id,
          title: src.title,
          publishedDate: src.publishedDate,
          publishedLink: src.publishedLink,
          postType: src.postType,
          views: src.views,
          evergreenReasoning: src.evergreenReasoning,
          account:
            src.accountId && src.accountPlatform && src.accountHandle
              ? {
                  id: src.accountId,
                  platform: src.accountPlatform,
                  handle: src.accountHandle,
                  displayName: src.accountDisplayName,
                }
              : null,
        };
    }

    // For cross-post items, also surface the scanner's decision: the LLM
    // reasoning, its confidence, and the per-checkpoint velocity signal on
    // the source post (15m/30m/1h/2h/4h). Triage dialog renders these.
    let crossPostSignals:
      | {
          confidence: number | null;
          reasoning: string | null;
          checkpoints: Array<{ label: string; views: number; ratio: number | null }>;
        }
      | null = null;
    if (item.sourceType === "cross_post") {
      const [decision] = await db
        .select({
          confidence: crossPostDecisions.confidence,
          reasoning: crossPostDecisions.reasoning,
        })
        .from(crossPostDecisions)
        .where(eq(crossPostDecisions.ideaItemId, item.id))
        .orderBy(desc(crossPostDecisions.proposedAt))
        .limit(1);

      const checkpoints: Array<{
        label: string;
        views: number;
        ratio: number | null;
      }> = [];
      if (item.repostedFromItemId) {
        // Every checkpoint snapshot we have for the source item + the
        // matching per-checkpoint baseline for its account+postType. One
        // query for snapshots, one for baselines.
        const snapshotRows = await db.execute<{
          checkpoint_key: string;
          views: number;
          account_id: string;
          post_type: string;
        }>(sql`
          SELECT vs.checkpoint_key,
                 vs.views,
                 pi.account_id,
                 pi.post_type
            FROM view_snapshots vs
            JOIN production_items pi ON pi.id = vs.production_item_id
           WHERE vs.production_item_id = ${item.repostedFromItemId}
             AND vs.checkpoint_key IS NOT NULL
          ORDER BY vs.checkpoint_key
        `);

        if (snapshotRows.length > 0) {
          const { account_id, post_type } = snapshotRows[0];
          const baselineRows = await db.execute<{
            checkpoint_key: string;
            baseline: string;
          }>(sql`
            SELECT vs.checkpoint_key,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY vs.views) AS baseline
              FROM view_snapshots vs
              JOIN production_items pi ON pi.id = vs.production_item_id
             WHERE pi.account_id = ${account_id}::uuid
               AND pi.post_type = ${post_type}
               AND pi.source_type = 'original'
               AND pi.status = 'Published'
               AND pi.deleted_at IS NULL
               AND pi.published_at >= (now() - interval '30 days')
               AND vs.checkpoint_key IS NOT NULL
             GROUP BY vs.checkpoint_key
            HAVING count(*) >= 5
          `);
          const baselineByKey = new Map(
            baselineRows.map((r) => [r.checkpoint_key, Number(r.baseline)])
          );
          // Preserve the canonical 15m → 4h ordering.
          const ORDER = ["15m", "30m", "1h", "2h", "4h"] as const;
          const byKey = new Map(
            snapshotRows.map((r) => [r.checkpoint_key, r.views])
          );
          for (const key of ORDER) {
            const views = byKey.get(key);
            if (views == null) continue;
            const baseline = baselineByKey.get(key);
            checkpoints.push({
              label: key,
              views,
              ratio: baseline && baseline > 0 ? views / baseline : null,
            });
          }
        }
      }

      crossPostSignals = {
        confidence: item.crossPostConfidence,
        reasoning: decision?.reasoning ?? null,
        checkpoints,
      };
    }

    // View-over-time trajectory for the sparkline. Only the scheduled
    // checkpoint-tagged snapshots (15m / 30m / 1h / 2h / 4h from publish)
    // — these are the consistent, publish-time-aligned points we
    // actually want to plot. Legacy untagged rows from the deleted
    // fresh-metrics-sync cron era are ignored.
    const viewHistoryRowsRaw = await db
      .select({
        takenAt: viewSnapshots.takenAt,
        views: viewSnapshots.views,
        postAgeMinutes: viewSnapshots.postAgeMinutes,
        checkpointKey: viewSnapshots.checkpointKey,
      })
      .from(viewSnapshots)
      .where(
        and(
          eq(viewSnapshots.productionItemId, item.id),
          isNotNull(viewSnapshots.checkpointKey)
        )
      )
      .orderBy(asc(viewSnapshots.takenAt));
    const viewHistoryRows = viewHistoryRowsRaw.map((r) => ({
      takenAt: r.takenAt.toISOString(),
      views: r.views,
      postAgeMinutes: r.postAgeMinutes,
      checkpointKey: r.checkpointKey,
    }));

    // Resolve the editor user record for the assignee picker.
    const editor = item.editorUserId
      ? (await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(eq(users.id, item.editorUserId))
          .limit(1))[0] ?? null
      : null;

    // Scope Repurpose targets to direct children of this item's source format.
    // The item stores its format as a text name, so resolve it via brandFormats.
    // Mirrors the columns the /{brand}/formats listing renders so the Repurpose
    // tab can use the same Table primitives: name, parent, channels, editor,
    // viewThreshold, totalViews (rolled up the same way as the formats page).
    const sourceFormat = item.format
      ? brandFormats.find((f) => f.name === item.format)
      : undefined;
    const repurposeTargetRows = sourceFormat
      ? await db
          .select({
            id: formats.id,
            name: formats.name,
            parentFormatId: formats.parentFormatId,
            instructions: formats.instructions,
            viewThreshold: formats.viewThreshold,
            editor: formats.editor,
          })
          .from(formats)
          .where(
            and(
              eq(formats.parentFormatId, sourceFormat.id),
              eq(formats.brand, item.brand)
            )
          )
          .orderBy(formats.name)
      : [];

    // Total views per format name in this brand. Same query shape the formats
    // listing uses (`/api/formats:41-58`) — repurpose targets are direct
    // children of one source format so a flat lookup is sufficient (no rollup
    // through grandchildren needed for the Repurpose tab today).
    const repurposeViewsRows =
      repurposeTargetRows.length > 0
        ? await db
            .select({
              format: productionItems.format,
              total: sql<string>`COALESCE(SUM(${productionItems.views}), 0)`,
            })
            .from(productionItems)
            .where(
              and(
                eq(productionItems.brand, item.brand),
                isNotNull(productionItems.format),
                inArray(
                  productionItems.format,
                  repurposeTargetRows.map((r) => r.name)
                )
              )
            )
            .groupBy(productionItems.format)
        : [];
    const totalViewsByFormatName = new Map<string, number>();
    for (const r of repurposeViewsRows) {
      if (r.format) totalViewsByFormatName.set(r.format, Number(r.total) || 0);
    }

    const repurposeChannelsByFormat = await getChannelsForFormats(
      repurposeTargetRows.map((r) => r.id)
    );

    const repurposeTargets = repurposeTargetRows.map((r) => ({
      id: r.id,
      name: r.name,
      parentFormatId: r.parentFormatId,
      instructions: r.instructions,
      viewThreshold: r.viewThreshold,
      editor: r.editor,
      accountChannels: repurposeChannelsByFormat.get(r.id) ?? [],
      totalViews: totalViewsByFormatName.get(r.name) ?? 0,
    }));

    // Top performers in this format: up to 3 published items with highest views.
    // Used to show creators benchmarks for the format they're creating in.
    // Looks for items that have been published (have publishedLink) with views data.
    // Only shows if item has a format assigned and there are published items in it.
    const topPerformers = item.format
      ? await db
          .select({
            id: productionItems.id,
            title: productionItems.title,
            views: productionItems.views,
            publishedDate: productionItems.publishedDate,
            thumbnail: productionItems.thumbnail,
            posterS3Key: productionItems.posterS3Key,
            mediaS3Key: productionItems.mediaS3Key,
            mediaS3Bucket: productionItems.mediaS3Bucket,
            mediaContentType: productionItems.mediaContentType,
          })
          .from(productionItems)
          .where(
            and(
              eq(productionItems.brand, item.brand),
              eq(productionItems.format, item.format),
              isNotNull(productionItems.publishedLink),
              isNotNull(productionItems.views),
              isNotNull(productionItems.publishedDate)
            )
          )
          .orderBy(desc(productionItems.views))
          .limit(3)
      : [];

    // Current draft (at most one row per item thanks to the partial unique
    // index). Null if the item has no draft yet. The UI renders fields based
    // on `fieldSchemaSnapshot` — decoupled from live format edits.
    const [currentDraft] = await db
      .select()
      .from(contentDrafts)
      .where(
        and(
          eq(contentDrafts.productionItemId, id),
          eq(contentDrafts.isCurrent, true),
        ),
      )
      .limit(1);

    // Predicted views — computed on the fly for pre-published items. Once the
    // item is "Published" we rely on the `predictedViewsSnapshot` column
    // (captured at the publish transition) and skip recomputation.
    let prediction: ViewPrediction | null = null;
    if (item.status !== "Published") {
      const ctx = await buildViewPredictorContext(item.brand);
      prediction = predictViews(
        {
          id: item.id,
          format: item.format,
          platforms: (item.platform as string[] | null) ?? null,
          pillarContentItemId: item.pillarContentItemId,
        },
        ctx
      );
    }

    // Transcript text for the item, if any has been captured (Descript or
    // any of the SC enrichers). Surfaced inline so the detail page doesn't
    // need a second round-trip.
    const [itemTranscript] = await db
      .select({
        fullText: transcripts.fullText,
        source: transcripts.source,
        model: transcripts.model,
        wordCount: transcripts.wordCount,
        durationSec: transcripts.durationSec,
        audioS3Bucket: transcripts.audioS3Bucket,
        audioS3Key: transcripts.audioS3Key,
      })
      .from(transcripts)
      .where(eq(transcripts.productionItemId, id))
      .limit(1);

    // Carousel / multi-image slides archived during enrichment. Ordered by
    // upstream slide position so index 0 is the cover.
    const mediaRows = await db
      .select({
        id: productionItemMedia.id,
        index: productionItemMedia.index,
        kind: productionItemMedia.kind,
        s3Key: productionItemMedia.s3Key,
        s3Bucket: productionItemMedia.s3Bucket,
        posterS3Key: productionItemMedia.posterS3Key,
        contentType: productionItemMedia.contentType,
        sizeBytes: productionItemMedia.sizeBytes,
        sourceUrl: productionItemMedia.sourceUrl,
      })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, id))
      .orderBy(asc(productionItemMedia.index));

    // Presign all S3-archived assets in parallel. Failures degrade to null
    // (callers fall back to the legacy `thumbnail` column on the row).
    // Pair each archived key with the bucket it actually lives in. Media
    // objects may be in R2 (source recordings upload there) or S3, so they
    // presign against the row's stored mediaS3Bucket. Posters are always
    // written to the default S3 bucket (extract-poster putObjects them there),
    // so they presign with bucket undefined → S3. media_assets rows carry
    // their own s3Bucket for both the asset and its poster.
    const keyBucketPairs: Array<{ key: string | null; bucket?: string }> = [
      { key: item.posterS3Key },
      { key: item.mediaS3Key, bucket: item.mediaS3Bucket ?? undefined },
      ...derivatives.flatMap((d) => [
        { key: d.posterS3Key },
        { key: d.mediaS3Key, bucket: d.mediaS3Bucket ?? undefined },
      ]),
      ...topPerformers.flatMap((t) => [
        { key: t.posterS3Key },
        { key: t.mediaS3Key, bucket: t.mediaS3Bucket ?? undefined },
      ]),
      ...reposts.flatMap((r) => [
        { key: r.posterS3Key },
        { key: r.mediaS3Key, bucket: r.mediaS3Bucket ?? undefined },
      ]),
      ...crossPosts.flatMap((r) => [
        { key: r.posterS3Key },
        { key: r.mediaS3Key, bucket: r.mediaS3Bucket ?? undefined },
      ]),
      ...mediaRows.flatMap((m) => [
        { key: m.s3Key, bucket: m.s3Bucket ?? undefined },
        { key: m.posterS3Key, bucket: m.s3Bucket ?? undefined },
      ]),
    ];
    const presignedByKey = new Map<string, string>();
    const seenKeys = new Set<string>();
    await Promise.all(
      keyBucketPairs
        .filter((p): p is { key: string; bucket?: string } => {
          if (!p.key || seenKeys.has(p.key)) return false;
          seenKeys.add(p.key);
          return true;
        })
        .map(async ({ key, bucket }) => {
          const url = await presignOrNull(key, bucket);
          if (url) presignedByKey.set(key, url);
        })
    );
    const urlFor = (key: string | null): string | null =>
      key ? (presignedByKey.get(key) ?? null) : null;

    // Build a single joined-account lookup for every row type this route
    // returns (derivatives, reposts, crossPosts, topPerformers). Avoids an
    // N+1 per list; one IN query per distinct accountId.
    const accountIdsToLookup = new Set<string>();
    for (const list of [derivatives, reposts, crossPosts, topPerformers]) {
      for (const r of list as Array<{ accountId?: string | null }>) {
        if (r.accountId) accountIdsToLookup.add(r.accountId);
      }
    }
    const accountById = new Map<
      string,
      {
        id: string;
        platform: string;
        handle: string;
        displayName: string | null;
        brandSlug: string;
        brandLabel: string;
      }
    >();
    if (accountIdsToLookup.size > 0) {
      const accountRows = await db
        .select({
          id: accounts.id,
          platform: accounts.platform,
          handle: accounts.handle,
          displayName: accounts.displayName,
          brandSlug: brands.slug,
          brandLabel: brands.label,
        })
        .from(accounts)
        .innerJoin(brands, eq(brands.id, accounts.brandId))
        .where(inArray(accounts.id, Array.from(accountIdsToLookup)));
      for (const r of accountRows) accountById.set(r.id, r);
    }
    const accountFor = (accountId: string | null | undefined) =>
      accountId ? accountById.get(accountId) ?? null : null;

    // Joined account summary for the UI's AccountBadge / picker AND for the
    // preview simulator card (handle, displayName, avatar, verified,
    // followerCount, bio). Null when the item predates the accounts backfill
    // (shouldn't happen in prod but kept defensive).
    let joinedAccount: {
      id: string;
      platform: string;
      handle: string;
      displayName: string | null;
      avatarUrl: string | null;
      brandSlug: string;
      brandLabel: string;
      verified: boolean | null;
      followerCount: number | null;
      bio: string | null;
    } | null = null;
    if (item.accountId) {
      const [row] = await db
        .select({
          id: accounts.id,
          platform: accounts.platform,
          handle: accounts.handle,
          displayName: accounts.displayName,
          avatarUrl: accounts.avatarUrl,
          brandSlug: brands.slug,
          brandLabel: brands.label,
          verified: accounts.verified,
          followerCount: accounts.followerCount,
          bio: accounts.bio,
        })
        .from(accounts)
        .innerJoin(brands, eq(brands.id, accounts.brandId))
        .where(eq(accounts.id, item.accountId))
        .limit(1);
      joinedAccount = row ?? null;
    }

    // Whether cross-post / repost can run for this item. Same gate both
    // routes now use — needs the source's own composition, own archived
    // video, or carousel image rows. Mirroring it here lets the UI
    // disable the buttons (and surface the reason in the tooltip)
    // instead of letting the user click through and get rejected.
    // `hasAnyCarouselRow` is what lets image-only sources (X carousels,
    // IG photos) pass the gate — without it `mediaS3Key === null` looks
    // like "no media" even though seedRepostContent handles carousels.
    const hasCarouselMedia = await hasAnyCarouselRow(item.id);
    const readiness = checkRepostReadiness(item, hasCarouselMedia);
    const canDuplicate = readiness.ok;
    const blockedReason = readiness.ok ? null : readiness.reason;

    // Gating for the "original media" Actions items. `hasWatermarkedMedia`:
    // the item's own video is a TikTok download. `cleanOriginAvailable`: a
    // clean original lives up the lineage (depth > 0) we can pull/download.
    const hasWatermarkedMedia = mediaRows.some(
      (m) => m.kind === "video" && classifyMediaSource(m.sourceUrl) === "tiktok_dirty",
    );
    let cleanOriginAvailable = false;
    let cleanOriginLabel: string | null = null;
    if (hasWatermarkedMedia || item.sourceType !== "original") {
      const clean = await resolveCleanSourceMedia(item.id);
      if (clean.kind === "archived" && clean.origin.depth > 0) {
        cleanOriginAvailable = true;
        cleanOriginLabel = clean.label;
      }
    }

    return NextResponse.json({
      item: {
        ...item,
        hasWatermarkedMedia,
        cleanOriginAvailable,
        cleanOriginLabel,
        ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
        apvFirst24Hours: item.apvFirst24Hours
          ? parseFloat(item.apvFirst24Hours)
          : null,
        posterUrl: urlFor(item.posterS3Key),
        mediaUrl: urlFor(item.mediaS3Key),
        account: joinedAccount,
        canCrossPost: canDuplicate,
        canRepost: canDuplicate,
        crossPostBlockedReason: blockedReason,
      },
      transcript: itemTranscript
        ? {
            fullText: itemTranscript.fullText,
            source: itemTranscript.source,
            model: itemTranscript.model,
            wordCount: itemTranscript.wordCount,
            durationSec: itemTranscript.durationSec
              ? parseFloat(itemTranscript.durationSec)
              : null,
            audioS3Bucket: itemTranscript.audioS3Bucket,
            audioS3Key: itemTranscript.audioS3Key,
          }
        : null,
      prediction,
      descendantViewsTotal,
      derivatives: derivatives.map((d) => ({
        ...d,
        ctrFirstHour: d.ctrFirstHour ? parseFloat(d.ctrFirstHour) : null,
        apvFirst24Hours: d.apvFirst24Hours
          ? parseFloat(d.apvFirst24Hours)
          : null,
        posterUrl: urlFor(d.posterS3Key),
        mediaUrl: urlFor(d.mediaS3Key),
        account: accountFor(d.accountId),
      })),
      formatNames: brandFormats.map((f) => f.name),
      formats: brandFormats,
      repurposeTargets,
      pillar,
      editor,
      topPerformers: topPerformers.map((t) => ({
        ...t,
        posterUrl: urlFor(t.posterS3Key),
        mediaUrl: urlFor(t.mediaS3Key),
      })),
      reposts: reposts.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        posterUrl: urlFor(r.posterS3Key),
        mediaUrl: urlFor(r.mediaS3Key),
        account: accountFor(r.accountId),
      })),
      crossPosts: crossPosts.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        posterUrl: urlFor(r.posterS3Key),
        mediaUrl: urlFor(r.mediaS3Key),
        account: accountFor(r.accountId),
      })),
      repostedFrom,
      crossPostSignals,
      viewHistory: viewHistoryRows,
      currentDraft: currentDraft ?? null,
      hasFieldSchema,
      media: mediaRows.map((m) => ({
        id: m.id,
        index: m.index,
        kind: m.kind,
        url: urlFor(m.s3Key),
        posterUrl: urlFor(m.posterS3Key),
        contentType: m.contentType,
        sizeBytes: m.sizeBytes,
      })),
    });
  } catch (error) {
    console.error("Error fetching production item:", error);
    return NextResponse.json(
      { error: "Failed to fetch item" },
      { status: 500 }
    );
  }
}
