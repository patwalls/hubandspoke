import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { crossPostRules } from "@/lib/db/schema";
import { and, eq, asc } from "drizzle-orm";
import { BRANDS } from "@/lib/config/brands";

const VALID_BRANDS = new Set<string>(BRANDS.map((b) => b.slug));

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand || !VALID_BRANDS.has(brand)) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(crossPostRules)
    .where(eq(crossPostRules.brand, brand))
    .orderBy(
      asc(crossPostRules.sourcePlatform),
      asc(crossPostRules.targetPlatform)
    );

  return NextResponse.json({ rules: rows });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { brand, sourcePlatform, viewThreshold, targetPlatform, active } =
      body as {
        brand?: string;
        sourcePlatform?: string;
        viewThreshold?: number;
        targetPlatform?: string;
        active?: boolean;
      };

    if (!brand || !VALID_BRANDS.has(brand)) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }
    if (!sourcePlatform?.trim() || !targetPlatform?.trim()) {
      return NextResponse.json(
        { error: "sourcePlatform and targetPlatform are required" },
        { status: 400 }
      );
    }
    if (sourcePlatform.trim() === targetPlatform.trim()) {
      return NextResponse.json(
        { error: "sourcePlatform and targetPlatform must differ" },
        { status: 400 }
      );
    }
    const n = Number(viewThreshold);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return NextResponse.json(
        { error: "viewThreshold must be a non-negative integer" },
        { status: 400 }
      );
    }

    const [row] = await db
      .insert(crossPostRules)
      .values({
        brand,
        sourcePlatform: sourcePlatform.trim(),
        viewThreshold: n,
        targetPlatform: targetPlatform.trim(),
        active: active !== false,
      })
      .onConflictDoUpdate({
        target: [
          crossPostRules.brand,
          crossPostRules.sourcePlatform,
          crossPostRules.targetPlatform,
        ],
        set: {
          viewThreshold: n,
          active: active !== false,
          updatedAt: new Date(),
        },
      })
      .returning();

    return NextResponse.json({ rule: row });
  } catch (error) {
    console.error("Error creating cross-post rule:", error);
    return NextResponse.json(
      { error: "Failed to save rule" },
      { status: 500 }
    );
  }
}
