import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brandStatuses } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { isStatusColorToken } from "@/lib/badge-colors";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const brand = request.nextUrl.searchParams.get("brand");
  const pipelineOnly =
    request.nextUrl.searchParams.get("pipelineOnly") === "1";
  if (!brand) {
    return NextResponse.json({ error: "Missing brand" }, { status: 400 });
  }

  // Cross-brand sentinel — returns the union of all brands' statuses
  // (or pipeline statuses), deduped by name. First occurrence wins for
  // color/order; the production /all view needs this for kanban columns.
  if (brand === "all") {
    const rows = await db
      .select()
      .from(brandStatuses)
      .where(
        pipelineOnly ? eq(brandStatuses.isPipelineColumn, true) : undefined
      )
      .orderBy(asc(brandStatuses.position));
    const byName = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!byName.has(r.name)) byName.set(r.name, r);
    }
    return NextResponse.json({
      statuses: Array.from(byName.values()),
    });
  }

  const brandRow = await fetchBrandBySlug(brand);
  if (!brandRow) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(brandStatuses)
    .where(
      pipelineOnly
        ? and(
            eq(brandStatuses.brandId, brandRow.id),
            eq(brandStatuses.isPipelineColumn, true)
          )
        : eq(brandStatuses.brandId, brandRow.id)
    )
    .orderBy(asc(brandStatuses.position));

  return NextResponse.json({ statuses: rows });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { brand, name, color, isPipelineColumn } = body as {
      brand?: string;
      name?: string;
      color?: string;
      isPipelineColumn?: boolean;
    };

    if (!brand) {
      return NextResponse.json({ error: "Missing brand" }, { status: 400 });
    }
    const brandRow = await fetchBrandBySlug(brand);
    if (!brandRow) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }

    const trimmedName = name?.trim();
    if (!trimmedName) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!isStatusColorToken(color)) {
      return NextResponse.json(
        { error: "color must be one of the supported tokens" },
        { status: 400 }
      );
    }

    // Append at the end of the existing list.
    const [last] = await db
      .select({ position: brandStatuses.position })
      .from(brandStatuses)
      .where(eq(brandStatuses.brandId, brandRow.id))
      .orderBy(desc(brandStatuses.position))
      .limit(1);
    const nextPosition = (last?.position ?? -1) + 1;

    try {
      const [row] = await db
        .insert(brandStatuses)
        .values({
          brandId: brandRow.id,
          name: trimmedName,
          color,
          position: nextPosition,
          isPipelineColumn: isPipelineColumn === true,
          isProtected: false,
        })
        .returning();
      return NextResponse.json({ status: row });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "23505") {
        return NextResponse.json(
          { error: `Status "${trimmedName}" already exists for this brand` },
          { status: 409 }
        );
      }
      throw err;
    }
  } catch (err) {
    console.error("Error creating brand status:", err);
    return NextResponse.json(
      { error: "Failed to create status" },
      { status: 500 }
    );
  }
}
