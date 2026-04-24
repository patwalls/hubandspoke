import { NextRequest, NextResponse } from "next/server";
import { and, eq, ilike, isNotNull, isNull, ne, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const brand = params.get("brand");
  const q = (params.get("q") || "").trim();
  const excludeId = params.get("excludeId");

  if (!brand) {
    return NextResponse.json({ error: "brand is required" }, { status: 400 });
  }

  const conditions = [
    eq(productionItems.brand, brand),
    isNotNull(productionItems.notionId),
    isNull(productionItems.deletedAt),
  ];
  if (excludeId) conditions.push(ne(productionItems.id, excludeId));
  if (q) conditions.push(ilike(productionItems.title, `%${q}%`));

  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      status: productionItems.status,
      notionId: productionItems.notionId,
    })
    .from(productionItems)
    .where(and(...conditions))
    .orderBy(desc(productionItems.publishedDate))
    .limit(25);

  return NextResponse.json({ items: rows });
}
