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
      weekStartDay: row?.weekStartDay ?? 0,
      defaultProducerUserId: row?.defaultProducerUserId ?? null,
      defaultEditorUserId: row?.defaultEditorUserId ?? null,
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
      weekStartDay,
      defaultProducerUserId,
      defaultEditorUserId,
    } = body as {
      brand?: string;
      weeklyGoal?: number | null;
      weekStartDay?: number;
      defaultProducerUserId?: string | null;
      defaultEditorUserId?: string | null;
    };

    if (!brand || !VALID_BRANDS.has(brand)) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }

    // Only overwrite fields the caller actually sent. `null` is a valid value
    // (clears the default → global fallback); `undefined` means "leave alone".
    const patch: Partial<typeof brandSettings.$inferInsert> = { updatedAt: new Date() };

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
      .insert(brandSettings)
      .values({
        brand,
        weeklyGoal: patch.weeklyGoal ?? null,
        weekStartDay: patch.weekStartDay ?? 0,
        defaultProducerUserId: patch.defaultProducerUserId ?? null,
        defaultEditorUserId: patch.defaultEditorUserId ?? null,
      })
      .onConflictDoUpdate({
        target: brandSettings.brand,
        set: patch,
      })
      .returning();

    return NextResponse.json({
      brand: row.brand,
      weeklyGoal: row.weeklyGoal,
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
