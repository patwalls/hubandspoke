import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brandSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { BRANDS } from "@/lib/config/brands";

const VALID_BRANDS = new Set<string>(BRANDS.map((b) => b.slug));

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand || !VALID_BRANDS.has(brand)) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  try {
    const [row] = await db
      .select()
      .from(brandSettings)
      .where(eq(brandSettings.brand, brand))
      .limit(1);

    return NextResponse.json({
      brand,
      weeklyGoal: row?.weeklyGoal ?? null,
    });
  } catch (error) {
    console.error("Error fetching brand settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { brand, weeklyGoal } = body as {
      brand?: string;
      weeklyGoal?: number | null;
    };

    if (!brand || !VALID_BRANDS.has(brand)) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }

    let normalizedGoal: number | null = null;
    if (weeklyGoal !== null && weeklyGoal !== undefined) {
      const n = Number(weeklyGoal);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return NextResponse.json(
          { error: "weeklyGoal must be a non-negative integer or null" },
          { status: 400 }
        );
      }
      normalizedGoal = n;
    }

    const [row] = await db
      .insert(brandSettings)
      .values({ brand, weeklyGoal: normalizedGoal })
      .onConflictDoUpdate({
        target: brandSettings.brand,
        set: { weeklyGoal: normalizedGoal, updatedAt: new Date() },
      })
      .returning();

    return NextResponse.json({
      brand: row.brand,
      weeklyGoal: row.weeklyGoal,
    });
  } catch (error) {
    console.error("Error updating brand settings:", error);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
