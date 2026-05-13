import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchBrandBySlug, invalidateBrandCache } from "@/lib/db/brands";

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) {
    return NextResponse.json({ error: "Missing brand" }, { status: 400 });
  }

  try {
    const row = await fetchBrandBySlug(brand);
    if (!row) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }
    return NextResponse.json({
      brand: row.slug,
      weeklyGoal: row.weeklyGoal ?? null,
      weeklyViewsGoal: row.weeklyViewsGoal ?? null,
      weekStartDay: row.weekStartDay ?? 0,
      defaultProducerUserId: row.defaultProducerUserId ?? null,
      defaultEditorUserId: row.defaultEditorUserId ?? null,
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
    const {
      brand,
      weeklyGoal,
      weeklyViewsGoal,
      weekStartDay,
      defaultProducerUserId,
      defaultEditorUserId,
    } = body as {
      brand?: string;
      weeklyGoal?: number | null;
      weeklyViewsGoal?: number | null;
      weekStartDay?: number;
      defaultProducerUserId?: string | null;
      defaultEditorUserId?: string | null;
    };

    if (!brand) {
      return NextResponse.json({ error: "Missing brand" }, { status: 400 });
    }
    const existing = await fetchBrandBySlug(brand);
    if (!existing) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }

    // Only overwrite fields the caller actually sent. `null` is a valid value
    // (clears the default → global fallback); `undefined` means "leave alone".
    const patch: Partial<typeof brands.$inferInsert> = { updatedAt: new Date() };

    if (weeklyGoal !== undefined) {
      if (weeklyGoal === null) {
        patch.weeklyGoal = null;
      } else {
        const n = Number(weeklyGoal);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          return NextResponse.json(
            { error: "weeklyGoal must be a non-negative integer or null" },
            { status: 400 }
          );
        }
        patch.weeklyGoal = n;
      }
    }
    if (weeklyViewsGoal !== undefined) {
      if (weeklyViewsGoal === null) {
        patch.weeklyViewsGoal = null;
      } else {
        const n = Number(weeklyViewsGoal);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          return NextResponse.json(
            { error: "weeklyViewsGoal must be a non-negative integer or null" },
            { status: 400 }
          );
        }
        patch.weeklyViewsGoal = n;
      }
    }
    if (weekStartDay !== undefined) {
      const n = Number(weekStartDay);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        return NextResponse.json(
          { error: "weekStartDay must be an integer 0–6 (0 = Sunday)" },
          { status: 400 }
        );
      }
      patch.weekStartDay = n;
    }
    if (defaultProducerUserId !== undefined) {
      patch.defaultProducerUserId = defaultProducerUserId || null;
    }
    if (defaultEditorUserId !== undefined) {
      patch.defaultEditorUserId = defaultEditorUserId || null;
    }

    const [row] = await db
      .update(brands)
      .set(patch)
      .where(eq(brands.slug, brand))
      .returning();

    invalidateBrandCache();

    return NextResponse.json({
      brand: row.slug,
      weeklyGoal: row.weeklyGoal,
      weeklyViewsGoal: row.weeklyViewsGoal,
      weekStartDay: row.weekStartDay,
      defaultProducerUserId: row.defaultProducerUserId,
      defaultEditorUserId: row.defaultEditorUserId,
    });
  } catch (error) {
    console.error("Error updating brand settings:", error);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
