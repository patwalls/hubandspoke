import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { brands, brandStatuses, productionItems } from "@/lib/db/schema";
import { isStatusColorToken } from "@/lib/badge-colors";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function loadStatusWithBrandSlug(
  id: string
): Promise<(typeof brandStatuses.$inferSelect & { brandSlug: string }) | null> {
  const [row] = await db
    .select({
      id: brandStatuses.id,
      brandId: brandStatuses.brandId,
      name: brandStatuses.name,
      color: brandStatuses.color,
      position: brandStatuses.position,
      isPipelineColumn: brandStatuses.isPipelineColumn,
      isProtected: brandStatuses.isProtected,
      createdAt: brandStatuses.createdAt,
      updatedAt: brandStatuses.updatedAt,
      brandSlug: brands.slug,
    })
    .from(brandStatuses)
    .innerJoin(brands, eq(brandStatuses.brandId, brands.id))
    .where(eq(brandStatuses.id, id))
    .limit(1);
  return row ?? null;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = await loadStatusWithBrandSlug(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const { name, color, position, isPipelineColumn } = body as {
      name?: string;
      color?: string;
      position?: number;
      isPipelineColumn?: boolean;
    };

    const patch: Partial<typeof brandStatuses.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      if (existing.isProtected) {
        return NextResponse.json(
          { error: "Cannot rename a protected status" },
          { status: 409 }
        );
      }
      const trimmed = name.trim();
      if (!trimmed) {
        return NextResponse.json(
          { error: "name cannot be empty" },
          { status: 400 }
        );
      }
      patch.name = trimmed;
    }

    if (color !== undefined) {
      if (!isStatusColorToken(color)) {
        return NextResponse.json(
          { error: "color must be one of the supported tokens" },
          { status: 400 }
        );
      }
      patch.color = color;
    }

    if (position !== undefined) {
      const n = Number(position);
      if (!Number.isInteger(n) || n < 0) {
        return NextResponse.json(
          { error: "position must be a non-negative integer" },
          { status: 400 }
        );
      }
      patch.position = n;
    }

    if (isPipelineColumn !== undefined) {
      patch.isPipelineColumn = Boolean(isPipelineColumn);
    }

    // If renaming, also rewrite production_items.status for rows on this
    // brand that still carry the old name — keeps chip color stable and
    // avoids a population of "ghost" status text not in the palette.
    const renamingFrom =
      patch.name && patch.name !== existing.name ? existing.name : null;

    try {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(brandStatuses)
          .set(patch)
          .where(eq(brandStatuses.id, id))
          .returning();
        if (renamingFrom) {
          await tx
            .update(productionItems)
            .set({ status: patch.name as string })
            .where(
              and(
                eq(productionItems.brand, existing.brandSlug),
                eq(productionItems.status, renamingFrom)
              )
            );
        }
        return updated;
      });
      return NextResponse.json({ status: result });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "23505") {
        return NextResponse.json(
          { error: "A status with that name already exists for this brand" },
          { status: 409 }
        );
      }
      throw err;
    }
  } catch (err) {
    console.error("Error updating brand status:", err);
    return NextResponse.json(
      { error: "Failed to update status" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = await loadStatusWithBrandSlug(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.isProtected) {
    return NextResponse.json(
      { error: "Cannot delete a protected status" },
      { status: 409 }
    );
  }

  const force = request.nextUrl.searchParams.get("force") === "1";

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, existing.brandSlug),
        eq(productionItems.status, existing.name)
      )
    );

  if (count > 0 && !force) {
    return NextResponse.json(
      {
        error: `${count} item(s) still use this status`,
        inUseCount: count,
      },
      { status: 409 }
    );
  }

  await db.delete(brandStatuses).where(eq(brandStatuses.id, id));
  return NextResponse.json({ ok: true, inUseCount: count });
}
