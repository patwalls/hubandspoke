import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  contentDrafts,
  productionItems,
  formats,
  transcripts,
  users,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  buildViewPredictorContext,
  predictViews,
  type ViewPrediction,
} from "@/lib/services/view-predictor";
import { resolveSchemaForPlatforms } from "@/lib/platform-field-schemas";
import { getPresignedGetUrl } from "@/lib/s3";

const POSTER_URL_TTL_SECONDS = 60 * 60;

async function presignOrNull(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await getPresignedGetUrl(key, POSTER_URL_TTL_SECONDS);
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
    const descendantViewsTotal = derivatives.reduce(
      (sum, d) => sum + (d.views ?? 0),
      0
    );

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
        status: productionItems.status,
        platform: productionItems.platform,
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

    let repostedFrom:
      | {
          id: string;
          title: string | null;
          publishedDate: string | null;
          publishedLink: string | null;
          platform: string[] | null;
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
          platform: productionItems.platform,
          views: productionItems.views,
          evergreenReasoning: productionItems.evergreenReasoning,
        })
        .from(productionItems)
        .where(eq(productionItems.id, item.repostedFromItemId))
        .limit(1);
      if (src)
        repostedFrom = {
          ...src,
          platform: (src.platform ?? null) as string[] | null,
        };
    }

    // Resolve producer + editor user records for the assignee pickers.
    // Separate queries keep the main item query simple and each is indexed.
    const assigneeIds = [item.producerUserId, item.editorUserId].filter(
      (v): v is string => !!v
    );
    const assigneeRows = assigneeIds.length
      ? await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(inArray(users.id, assigneeIds))
      : [];
    const byId = new Map(assigneeRows.map((u) => [u.id, u]));
    const producer = item.producerUserId
      ? byId.get(item.producerUserId) ?? null
      : null;
    const editor = item.editorUserId ? byId.get(item.editorUserId) ?? null : null;

    // Scope Repurpose targets to direct children of this item's source format.
    // The item stores its format as a text name, so resolve it via brandFormats.
    const sourceFormat = item.format
      ? brandFormats.find((f) => f.name === item.format)
      : undefined;
    const repurposeTargets = sourceFormat
      ? await db
          .select({
            id: formats.id,
            name: formats.name,
            parentFormatId: formats.parentFormatId,
            instructions: formats.instructions,
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
        wordCount: transcripts.wordCount,
        durationSec: transcripts.durationSec,
      })
      .from(transcripts)
      .where(eq(transcripts.productionItemId, id))
      .limit(1);

    // Presign all S3-archived assets in parallel. Failures degrade to null
    // (callers fall back to the legacy `thumbnail` column on the row).
    const allS3Keys = [
      item.posterS3Key,
      item.mediaS3Key,
      ...derivatives.map((d) => d.posterS3Key),
      ...topPerformers.map((t) => t.posterS3Key),
      ...reposts.map((r) => r.posterS3Key),
      ...crossPosts.map((r) => r.posterS3Key),
    ];
    const presignedByKey = new Map<string, string>();
    await Promise.all(
      Array.from(new Set(allS3Keys.filter((k): k is string => !!k))).map(
        async (key) => {
          const url = await presignOrNull(key);
          if (url) presignedByKey.set(key, url);
        }
      )
    );
    const urlFor = (key: string | null): string | null =>
      key ? (presignedByKey.get(key) ?? null) : null;

    return NextResponse.json({
      item: {
        ...item,
        salesAmount: item.salesAmount ? parseFloat(item.salesAmount) : null,
        ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
        apvFirst24Hours: item.apvFirst24Hours
          ? parseFloat(item.apvFirst24Hours)
          : null,
        posterUrl: urlFor(item.posterS3Key),
        mediaUrl: urlFor(item.mediaS3Key),
      },
      transcript: itemTranscript
        ? {
            fullText: itemTranscript.fullText,
            source: itemTranscript.source,
            wordCount: itemTranscript.wordCount,
            durationSec: itemTranscript.durationSec
              ? parseFloat(itemTranscript.durationSec)
              : null,
          }
        : null,
      prediction,
      descendantViewsTotal,
      derivatives: derivatives.map((d) => ({
        ...d,
        salesAmount: d.salesAmount ? parseFloat(d.salesAmount) : null,
        ctrFirstHour: d.ctrFirstHour ? parseFloat(d.ctrFirstHour) : null,
        apvFirst24Hours: d.apvFirst24Hours
          ? parseFloat(d.apvFirst24Hours)
          : null,
        posterUrl: urlFor(d.posterS3Key),
      })),
      formatNames: brandFormats.map((f) => f.name),
      formats: brandFormats,
      repurposeTargets,
      pillar,
      producer,
      editor,
      topPerformers: topPerformers.map((t) => ({
        ...t,
        posterUrl: urlFor(t.posterS3Key),
      })),
      reposts: reposts.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        posterUrl: urlFor(r.posterS3Key),
      })),
      crossPosts: crossPosts.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        posterUrl: urlFor(r.posterS3Key),
      })),
      repostedFrom,
      currentDraft: currentDraft ?? null,
      hasFieldSchema,
    });
  } catch (error) {
    console.error("Error fetching production item:", error);
    return NextResponse.json(
      { error: "Failed to fetch item" },
      { status: 500 }
    );
  }
}
