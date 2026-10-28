import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentComments, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireBrandEdit } from "@/lib/auth-guards";
import { brandOfComment } from "@/lib/brand-access";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Mark a note done / reopen it (review-notes M2). Unlike edit/delete this
 * isn't limited to the author: the editor who handled the note is usually
 * the one who checks it off.
 *
 * Body: `{ resolved: boolean }`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const guard = await requireBrandEdit(await brandOfComment(id));
    if (guard.response) return guard.response;
    const session = guard.session;
    const body = await request.json().catch(() => null);
    if (typeof body?.resolved !== "boolean") {
      return NextResponse.json(
        { error: "resolved must be true or false" },
        { status: 400 },
      );
    }

    const [updated] = await db
      .update(contentComments)
      .set(
        body.resolved
          ? { resolvedAt: new Date(), resolvedByUserId: session.user.id, resolvedByRenderId: null }
          : { resolvedAt: null, resolvedByUserId: null, resolvedByRenderId: null },
      )
      .where(eq(contentComments.id, id))
      .returning({
        resolvedAt: contentComments.resolvedAt,
        resolvedByUserId: contentComments.resolvedByUserId,
      });
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let resolvedByName: string | null = null;
    if (updated.resolvedByUserId) {
      const [u] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, updated.resolvedByUserId))
        .limit(1);
      resolvedByName = u?.name ?? null;
    }

    return NextResponse.json({
      resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
      resolvedByName,
    });
  } catch (error) {
    console.error("Error resolving comment:", error);
    return NextResponse.json(
      { error: "Failed to update comment" },
      { status: 500 },
    );
  }
}
