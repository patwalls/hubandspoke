import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchBrandBySlug, invalidateBrandCache } from "@/lib/db/brands";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const existing = await fetchBrandBySlug(slug);
  if (!existing) {
    return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const { label, avatarUrl, color, disabled } = body as {
      label?: string;
      avatarUrl?: string | null;
      color?: string | null;
      disabled?: boolean;
    };

    const patch: Partial<typeof brands.$inferInsert> = { updatedAt: new Date() };
    if (label !== undefined) {
      if (!label.trim()) {
        return NextResponse.json(
          { error: "label cannot be empty" },
          { status: 400 }
        );
      }
      patch.label = label.trim();
    }
    if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl || null;
    if (color !== undefined) patch.color = color || null;
    if (disabled !== undefined) patch.disabled = disabled;

    const [row] = await db
      .update(brands)
      .set(patch)
      .where(eq(brands.slug, slug))
      .returning();

    invalidateBrandCache();
    return NextResponse.json({ brand: row });
  } catch (error) {
    console.error("Error updating brand:", error);
    return NextResponse.json(
      { error: "Failed to update brand" },
      { status: 500 }
    );
  }
}
