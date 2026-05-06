import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentComments, productionItems, users } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { htmlToPlainText, sanitizeCommentHtml } from "@/lib/comments/sanitize";
import { extractMentionUserIds } from "@/lib/comments/extract-mentions";
import { enqueueNotification } from "@/lib/services/notifications";

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
    const plain = htmlToPlainText(sanitized);
    // Image-only / file-only edits are valid — see POST route.
    const hasAttachment = /<(img|a)\b/i.test(sanitized);
    if (!plain && !hasAttachment) {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }

    // Load the previous body so we can notify only newly added mentions.
    const [previous] = await db
      .select({
        body: contentComments.body,
        contentItemId: contentComments.contentItemId,
      })
      .from(contentComments)
      .where(
        and(
          eq(contentComments.id, id),
          eq(contentComments.userId, session.user.id),
        ),
      )
      .limit(1);

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

    // Notify mentions added by this edit (diff against previous body).
    if (previous) {
      const prevMentions = new Set(extractMentionUserIds(previous.body));
      const newMentions = extractMentionUserIds(sanitized);
      const added = newMentions.filter((uid) => !prevMentions.has(uid));
      if (added.length > 0) {
        const [item] = await db
          .select({ id: productionItems.id, title: productionItems.title })
          .from(productionItems)
          .where(eq(productionItems.id, previous.contentItemId))
          .limit(1);
        const excerpt = plain.slice(0, 240);
        const authorName = user?.name || user?.email || null;
        for (const mentionedId of added) {
          void enqueueNotification({
            userId: mentionedId,
            kind: "mention",
            contentItemId: previous.contentItemId,
            commentId: updated.id,
            actorUserId: session.user.id,
            payload: {
              kind: "mention",
              title: item?.title ?? null,
              excerpt,
              authorName,
            },
          }).catch((err) =>
            console.error("[comment-edit] mention notify failed", err),
          );
        }
      }
    }

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
