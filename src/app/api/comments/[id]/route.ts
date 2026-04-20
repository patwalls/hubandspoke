import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentComments, users } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { htmlToPlainText, sanitizeCommentHtml } from "@/lib/comments/sanitize";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_BODY = 5000;

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    const body = await request.json();
    const raw = typeof body?.body === "string" ? body.body : "";
    if (raw.length > MAX_BODY) {
      return NextResponse.json(
        { error: `body exceeds ${MAX_BODY} characters` },
        { status: 400 },
      );
    }
    const sanitized = sanitizeCommentHtml(raw);
    if (!htmlToPlainText(sanitized)) {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }

    const [updated] = await db
      .update(contentComments)
      .set({ body: sanitized, editedAt: new Date() })
      .where(
        and(
          eq(contentComments.id, id),
          eq(contentComments.userId, session.user.id),
        ),
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    return NextResponse.json({
      comment: {
        id: updated.id,
        body: updated.body,
        createdAt: updated.createdAt.toISOString(),
        editedAt: updated.editedAt ? updated.editedAt.toISOString() : null,
        user: user
          ? {
              id: user.id,
              name: user.name,
              email: user.email,
              avatarUrl: user.avatarUrl,
            }
          : null,
        isMine: true,
      },
    });
  } catch (error) {
    console.error("Error updating comment:", error);
    return NextResponse.json(
      { error: "Failed to update comment" },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    const deleted = await db
      .delete(contentComments)
      .where(
        and(
          eq(contentComments.id, id),
          eq(contentComments.userId, session.user.id),
        ),
      )
      .returning({ id: contentComments.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting comment:", error);
    return NextResponse.json(
      { error: "Failed to delete comment" },
      { status: 500 },
    );
  }
}
