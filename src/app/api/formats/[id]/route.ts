import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  formats,
  productionItems,
} from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const [format] = await db
      .select()
      .from(formats)
      .where(eq(formats.id, id))
      .limit(1);

    if (!format) {
      return NextResponse.json({ error: "Format not found" }, { status: 404 });
    }

    const children = await db
      .select()
      .from(formats)
      .where(eq(formats.parentFormatId, id))
      .orderBy(formats.name);

    // Walk up the chain to build an ancestors breadcrumb.
    const ancestors: { id: string; name: string }[] = [];
    let cursor = format.parentFormatId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const [row] = await db
        .select({ id: formats.id, name: formats.name, parentFormatId: formats.parentFormatId })
        .from(formats)
        .where(eq(formats.id, cursor));
      if (!row) break;
      ancestors.unshift({ id: row.id, name: row.name });
      cursor = row.parentFormatId;
    }

    const allItems = await db
      .select()
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, format.brand),
          eq(productionItems.format, format.name)
        )
      )
      .orderBy(desc(productionItems.views));

    // Killed ideas don't belong in the format's content roster — they're dead
    // weight in the table and skew perceptions of format performance.
    const items = allItems.filter((i) => i.status !== "Killed");

    const publishedItems = items.filter(
      (i) => i.status === "Published" && i.publishedDate
    );
    const totalPosts = publishedItems.length;
    const totalViews = publishedItems.reduce((sum, i) => sum + (i.views || 0), 0);
    const itemsWithViews = publishedItems.filter((i) => (i.views || 0) > 0);
    const avgViews = itemsWithViews.length
      ? Math.round(totalViews / itemsWithViews.length)
      : 0;

    let lastPublished: string | null = null;
    publishedItems.forEach((i) => {
      if (i.publishedDate && (!lastPublished || i.publishedDate > lastPublished)) {
        lastPublished = i.publishedDate;
      }
    });

    return NextResponse.json({
      format,
      children,
      ancestors,
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        platform: i.platform,
        publishedDate: i.publishedDate,
        publishedLink: i.publishedLink,
        thumbnail: i.thumbnail,
        views: i.views,
        likes: i.likes,
        comments: i.comments,
        leads: i.leads,
        salesAmount: i.salesAmount ? parseFloat(i.salesAmount) : null,
        status: i.status,
        viewsEstimated: i.viewsEstimated ?? false,
        descriptProjectUrl: i.descriptProjectUrl,
      })),
      metrics: {
        totalPosts,
        totalViews,
        avgViews,
        lastPublished,
      },
    });
  } catch (error) {
    console.error("Error fetching format detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch format" },
      { status: 500 }
    );
  }
}
