import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems, formats, repurposeTriggers } from "@/lib/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";

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

    const related = item.title
      ? await db
          .select()
          .from(productionItems)
          .where(
            and(
              eq(productionItems.brand, item.brand),
              eq(productionItems.title, item.title),
              ne(productionItems.id, id)
            )
          )
          .orderBy(desc(productionItems.publishedDate))
      : [];

    const brandFormats = await db
      .select({
        id: formats.id,
        name: formats.name,
        contentType: formats.contentType,
        instructions: formats.instructions,
      })
      .from(formats)
      .where(eq(formats.brand, item.brand))
      .orderBy(formats.name);

    const triggerRows = await db
      .select({
        id: repurposeTriggers.id,
        targetFormatId: repurposeTriggers.targetFormatId,
        targetFormatName: formats.name,
        descriptCompositionId: repurposeTriggers.descriptCompositionId,
        descriptProjectUrl: repurposeTriggers.descriptProjectUrl,
        descriptJobId: repurposeTriggers.descriptJobId,
        descriptPrompt: repurposeTriggers.descriptPrompt,
        compositionName: repurposeTriggers.compositionName,
        triggeredAt: repurposeTriggers.triggeredAt,
      })
      .from(repurposeTriggers)
      .leftJoin(formats, eq(formats.id, repurposeTriggers.targetFormatId))
      .where(eq(repurposeTriggers.productionItemId, id))
      .orderBy(desc(repurposeTriggers.triggeredAt));

    return NextResponse.json({
      item: {
        ...item,
        salesAmount: item.salesAmount ? parseFloat(item.salesAmount) : null,
        ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
        apvFirst24Hours: item.apvFirst24Hours
          ? parseFloat(item.apvFirst24Hours)
          : null,
      },
      triggers: triggerRows.map((t) => ({
        ...t,
        triggeredAt: t.triggeredAt.toISOString(),
      })),
      related: related.map((r) => ({
        ...r,
        salesAmount: r.salesAmount ? parseFloat(r.salesAmount) : null,
        ctrFirstHour: r.ctrFirstHour ? parseFloat(r.ctrFirstHour) : null,
        apvFirst24Hours: r.apvFirst24Hours
          ? parseFloat(r.apvFirst24Hours)
          : null,
      })),
      formatNames: brandFormats.map((f) => f.name),
      formats: brandFormats,
    });
  } catch (error) {
    console.error("Error fetching production item:", error);
    return NextResponse.json(
      { error: "Failed to fetch item" },
      { status: 500 }
    );
  }
}
