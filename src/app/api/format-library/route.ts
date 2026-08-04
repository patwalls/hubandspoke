import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formats, brands, productionItems, formatChannels } from "@/lib/db/schema";
import { eq, ne, and, inArray, isNotNull, desc } from "drizzle-orm";
import {
  buildProvenStatusMap,
  PROVEN_WINDOW_DAYS,
  type FormatProvenStatus,
} from "@/lib/services/format-proven";

// 180-day window — matches PROVEN_WINDOW_DAYS so proven status and activity
// filter use the same window.
const ACTIVITY_WINDOW_DAYS = PROVEN_WINDOW_DAYS;

export async function GET(request: NextRequest) {
  try {
    const exclude = request.nextUrl.searchParams.get("exclude");

    const rows = await db
      .select({
        id: formats.id,
        name: formats.name,
        brand: formats.brand,
        brandLabel: brands.label,
        instructions: formats.instructions,
        parentFormatId: formats.parentFormatId,
        isClippableFormat: formats.isClippableFormat,
        labelsAsOriginal: formats.labelsAsOriginal,
        isCanvaFormat: formats.isCanvaFormat,
        clipTargetPostType: formats.clipTargetPostType,
        clipTargetPlatform: formats.clipTargetPlatform,
        clipAspectRatio: formats.clipAspectRatio,
        viewThreshold: formats.viewThreshold,
      })
      .from(formats)
      .innerJoin(brands, eq(brands.slug, formats.brand))
      .where(
        exclude
          ? and(ne(formats.brand, exclude), eq(brands.disabled, false))
          : eq(brands.disabled, false)
      )
      .orderBy(brands.sortOrder, formats.name);

    if (rows.length === 0) return NextResponse.json([]);

    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    const formatIds = rows.map((r) => r.id);
    const brandSlugs = [...new Set(rows.map((r) => r.brand))];

    // Collect distinct postTypes per format from format_channels.
    const postTypesByFormatId = new Map<string, string[]>();
    if (formatIds.length > 0) {
      const fcRows = await db
        .selectDistinct({ formatId: formatChannels.formatId, postType: formatChannels.postType })
        .from(formatChannels)
        .where(
          and(
            inArray(formatChannels.formatId, formatIds),
            isNotNull(formatChannels.postType)
          )
        );
      for (const row of fcRows) {
        if (!row.postType) continue;
        const arr = postTypesByFormatId.get(row.formatId) ?? [];
        if (!arr.includes(row.postType)) arr.push(row.postType);
        postTypesByFormatId.set(row.formatId, arr);
      }
    }

    interface PublishedItem {
      brand: string;
      format: string | null;
      title: string | null;
      views: number | null;
      postType: string | null;
      contentMediaUrl: string | null;
      youtubeUrl: string | null;
      typefullyShareUrl: string | null;
      publishedDate: string | null;
    }

    interface ExampleEntry {
      title: string | null;
      views: number | null;
      postType: string | null;
      contentMediaUrl: string | null;
      // null when no URL is stored (e.g. X posts synced from the platform API).
      // The dialog renders these as non-clickable.
      url: string | null;
    }

    // key: `${brand}::${formatName.toLowerCase()}`
    const examplesByKey = new Map<string, ExampleEntry[]>();
    const count180dByKey = new Map<string, number>();
    const lastPublishedByKey = new Map<string, string>();
    const provenByKey = new Map<string, FormatProvenStatus>();

    const windowStart = new Date(
      Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);

    if (brandSlugs.length > 0) {
      // Fetch all published items for library brands, ordered by views DESC so
      // first-seen per key = best example. No URL filter — items without a URL
      // still contribute to activity counts and can appear as non-clickable
      // examples (title + views), e.g. X posts synced from the platform API.
      const allItems = await db
        .select({
          brand: productionItems.brand,
          format: productionItems.format,
          title: productionItems.title,
          views: productionItems.views,
          postType: productionItems.postType,
          contentMediaUrl: productionItems.contentMediaUrl,
          youtubeUrl: productionItems.youtubeUrl,
          typefullyShareUrl: productionItems.typefullyShareUrl,
          publishedDate: productionItems.publishedDate,
        })
        .from(productionItems)
        .where(
          and(
            eq(productionItems.status, "Published"),
            isNotNull(productionItems.format),
            inArray(productionItems.brand, brandSlugs)
          )
        )
        .orderBy(desc(productionItems.views), desc(productionItems.publishedAt)) as PublishedItem[];

      for (const item of allItems) {
        if (!item.format) continue;
        const key = `${item.brand}::${item.format.toLowerCase()}`;

        // Top-2 examples (all-time, best by views).
        const arr = examplesByKey.get(key) ?? [];
        if (arr.length < 2) {
          arr.push({
            title: item.title,
            views: item.views,
            postType: item.postType,
            contentMediaUrl: item.contentMediaUrl,
            url: item.youtubeUrl ?? item.typefullyShareUrl ?? null,
          });
          examplesByKey.set(key, arr);
        }

        // Activity metrics for curation filter + sort.
        if (item.publishedDate && item.publishedDate >= windowStart) {
          count180dByKey.set(key, (count180dByKey.get(key) ?? 0) + 1);
          // Items are already ordered by views DESC then publishedAt DESC.
          // For lastPublished we want the most-recent date, so we need a
          // separate pass — use a plain max-string comparison (ISO dates sort
          // lexicographically).
          const prev = lastPublishedByKey.get(key);
          if (!prev || item.publishedDate > prev) {
            lastPublishedByKey.set(key, item.publishedDate);
          }
        }
      }

      // Proven status — same 180-day window.
      for (const brandSlug of brandSlugs) {
        const brandItems = allItems
          .filter(
            (item): item is PublishedItem & { format: string; publishedDate: string } =>
              item.brand === brandSlug &&
              item.format !== null &&
              item.publishedDate !== null &&
              item.publishedDate >= windowStart
          )
          .map((item) => ({
            format: item.format,
            postType: item.postType,
            views: item.views ?? 0,
            publishedDate: item.publishedDate,
          }));

        if (brandItems.length === 0) continue;
        const statusMap = buildProvenStatusMap(brandItems);
        for (const [formatName, status] of statusMap) {
          provenByKey.set(`${brandSlug}::${formatName.toLowerCase()}`, status);
        }
      }
    }

    // Build result: filter to formats with activity in last 180 days,
    // then sort within each brand group (proven first, then count180d DESC,
    // then most recently published).
    const result = rows
      .map((r) => {
        const key = `${r.brand}::${r.name.toLowerCase()}`;
        const count180d = count180dByKey.get(key) ?? 0;
        const proven = provenByKey.get(key) ?? null;
        return {
          id: r.id,
          name: r.name,
          brand: r.brand,
          brandLabel: r.brandLabel,
          instructions: r.instructions,
          parentFormatId: r.parentFormatId,
          parentName: r.parentFormatId ? (nameById.get(r.parentFormatId) ?? null) : null,
          isClippableFormat: r.isClippableFormat,
          isCanvaFormat: r.isCanvaFormat,
          labelsAsOriginal: r.labelsAsOriginal,
          clipTargetPostType: r.clipTargetPostType,
          clipAspectRatio: r.clipAspectRatio,
          viewThreshold: r.viewThreshold,
          postTypes: postTypesByFormatId.get(r.id) ?? [],
          examples: examplesByKey.get(key) ?? [],
          provenStatus: proven
            ? { isProven: proven.isProven, reason: proven.reason }
            : null,
          // Internal sort keys — not exposed to client but used for ordering.
          _count180d: count180d,
          _lastPublished: lastPublishedByKey.get(key) ?? "",
        };
      })
      // Curation filter: only show formats with activity in the last 180 days.
      .filter((r) => r._count180d >= 1)
      // Sort: proven first, then by activity count, then by most recently published.
      .sort((a, b) => {
        // Primary: brand sort order is already baked into the row order from
        // the DB query; we sort WITHIN brand groups only.
        if (a.brand !== b.brand) return 0; // preserve original brand ordering
        const aProven = a.provenStatus?.isProven ? 1 : 0;
        const bProven = b.provenStatus?.isProven ? 1 : 0;
        if (bProven !== aProven) return bProven - aProven;
        if (b._count180d !== a._count180d) return b._count180d - a._count180d;
        return b._lastPublished.localeCompare(a._lastPublished);
      })
      // Strip internal keys before sending to client.
      .map(({ _count180d: _c, _lastPublished: _l, ...r }) => r);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching format library:", error);
    return NextResponse.json({ error: "Failed to fetch format library" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      sourceFormatId: string;
      destinationBrand: string;
      parentFormatId: string | null;
    };
    const { sourceFormatId, destinationBrand, parentFormatId } = body;

    if (!sourceFormatId || !destinationBrand) {
      return NextResponse.json({ error: "sourceFormatId and destinationBrand are required" }, { status: 400 });
    }

    const [source] = await db
      .select()
      .from(formats)
      .where(eq(formats.id, sourceFormatId));

    if (!source) {
      return NextResponse.json({ error: "Source format not found" }, { status: 404 });
    }

    if (parentFormatId) {
      const [parent] = await db
        .select({ id: formats.id, brand: formats.brand })
        .from(formats)
        .where(eq(formats.id, parentFormatId));
      if (!parent) {
        return NextResponse.json({ error: "Parent format not found" }, { status: 400 });
      }
      if (parent.brand !== destinationBrand) {
        return NextResponse.json(
          { error: "Parent format must belong to the destination brand" },
          { status: 400 }
        );
      }
    }

    const [created] = await db
      .insert(formats)
      .values({
        name: source.name,
        brand: destinationBrand,
        channels: [],
        instructions: source.instructions,
        viewThreshold: source.viewThreshold,
        isClippableFormat: source.isClippableFormat,
        isCanvaFormat: source.isCanvaFormat,
        labelsAsOriginal: source.labelsAsOriginal,
        clipTargetPostType: source.clipTargetPostType,
        clipTargetPlatform: source.clipTargetPlatform ?? null,
        clipAspectRatio: source.clipAspectRatio,
        parentFormatId: parentFormatId ?? null,
      })
      .returning();

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "A format with this name already exists in this brand." },
        { status: 409 }
      );
    }
    console.error("Error cloning format from library:", error);
    return NextResponse.json({ error: "Failed to use format" }, { status: 500 });
  }
}
