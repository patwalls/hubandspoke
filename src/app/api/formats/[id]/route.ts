import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  formats,
  formatRepurposeMappings,
  productionItems,
} from "@/lib/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";

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

    const mappings = await db
      .select()
      .from(formatRepurposeMappings)
      .where(eq(formatRepurposeMappings.sourceFormatId, id));

    const items = await db
      .select()
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, format.brand),
          eq(productionItems.format, format.name)
        )
      )
      .orderBy(desc(productionItems.views));

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
      format: {
        ...format,
        repurposeTargetIds: mappings.map((m) => m.targetFormatId),
      },
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
