import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  productionItems,
  formats,
  formatRepurposeMappings,
} from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

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

    // Derivatives: every production item whose "Pillar Content" relation in
    // Notion points at this item. Includes all statuses (Idea, Draft,
    // Published, anything). Indexed lookup on pillar_content_item_id FK.
    const derivatives = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.pillarContentItemId, id))
      .orderBy(desc(productionItems.publishedDate));

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

    // Scope Repurpose targets to formats explicitly mapped from this item's
    // source format. The item stores its format as a text name, so resolve
    // the name to an id via this brand's formats.
    const sourceFormat = item.format
      ? brandFormats.find((f) => f.name === item.format)
      : undefined;
    let repurposeTargetIds: string[] = [];
    if (sourceFormat) {
      const mappings = await db
        .select({ targetFormatId: formatRepurposeMappings.targetFormatId })
        .from(formatRepurposeMappings)
        .where(eq(formatRepurposeMappings.sourceFormatId, sourceFormat.id));
      repurposeTargetIds = mappings.map((m) => m.targetFormatId);
    }
    const repurposeTargets = repurposeTargetIds.length
      ? brandFormats.filter((f) => repurposeTargetIds.includes(f.id))
      : [];

    return NextResponse.json({
      item: {
        ...item,
        salesAmount: item.salesAmount ? parseFloat(item.salesAmount) : null,
        ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
        apvFirst24Hours: item.apvFirst24Hours
          ? parseFloat(item.apvFirst24Hours)
          : null,
      },
      derivatives: derivatives.map((d) => ({
        ...d,
        salesAmount: d.salesAmount ? parseFloat(d.salesAmount) : null,
        ctrFirstHour: d.ctrFirstHour ? parseFloat(d.ctrFirstHour) : null,
        apvFirst24Hours: d.apvFirst24Hours
          ? parseFloat(d.apvFirst24Hours)
          : null,
      })),
      formatNames: brandFormats.map((f) => f.name),
      formats: brandFormats,
      repurposeTargets,
    });
  } catch (error) {
    console.error("Error fetching production item:", error);
    return NextResponse.json(
      { error: "Failed to fetch item" },
      { status: 500 }
    );
  }
}
