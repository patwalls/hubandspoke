import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  productionItems,
  formats,
} from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";

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

    return NextResponse.json({
      item: {
        ...item,
        salesAmount: item.salesAmount ? parseFloat(item.salesAmount) : null,
        ctrFirstHour: item.ctrFirstHour ? parseFloat(item.ctrFirstHour) : null,
        apvFirst24Hours: item.apvFirst24Hours
          ? parseFloat(item.apvFirst24Hours)
          : null,
      },
      descendantViewsTotal,
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
      pillar,
    });
  } catch (error) {
    console.error("Error fetching production item:", error);
    return NextResponse.json(
      { error: "Failed to fetch item" },
      { status: 500 }
    );
  }
}
