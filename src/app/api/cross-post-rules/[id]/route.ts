import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { crossPostRules } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.viewThreshold !== undefined) {
      const n = Number(body.viewThreshold);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return NextResponse.json(
          { error: "viewThreshold must be a non-negative integer" },
          { status: 400 }
        );
      }
      updates.viewThreshold = n;
    }
    if (body.active !== undefined) updates.active = !!body.active;
    if (body.sourcePlatform !== undefined) {
      if (!body.sourcePlatform?.trim())
        return NextResponse.json(
          { error: "sourcePlatform cannot be empty" },
          { status: 400 }
        );
      updates.sourcePlatform = body.sourcePlatform.trim();
    }
    if (body.targetPlatform !== undefined) {
      if (!body.targetPlatform?.trim())
        return NextResponse.json(
          { error: "targetPlatform cannot be empty" },
          { status: 400 }
        );
      updates.targetPlatform = body.targetPlatform.trim();
    }

    const [row] = await db
      .update(crossPostRules)
      .set(updates)
      .where(eq(crossPostRules.id, id))
      .returning();

    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ rule: row });
  } catch (error) {
    console.error("Error updating cross-post rule:", error);
    return NextResponse.json(
      { error: "Failed to update rule" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const [row] = await db
      .delete(crossPostRules)
      .where(eq(crossPostRules.id, id))
      .returning();
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting cross-post rule:", error);
    return NextResponse.json(
      { error: "Failed to delete rule" },
      { status: 500 }
    );
  }
}
