import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentComments, productionItems, users } from "@/lib/db/schema";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { enqueueNotification } from "@/lib/services/notifications";
import { htmlToPlainText, sanitizeCommentHtml } from "@/lib/comments/sanitize";
import { extractMentionUserIds } from "@/lib/comments/extract-mentions";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_BODY = 5000;

function shape(row: {
  comment: typeof contentComments.$inferSelect;
  user: typeof users.$inferSelect | null;
}, currentUserId: string | null) {
  return {
    id: row.comment.id,
    body: row.comment.body,
    createdAt: row.comment.createdAt.toISOString(),
    editedAt: row.comment.editedAt ? row.comment.editedAt.toISOString() : null,
    user: row.user
      ? {
          id: row.user.id,
          name: row.user.name,
          email: row.user.email,
          avatarUrl: row.user.avatarUrl,
        }
      : null,
    authorName: row.comment.authorName,
    authorAvatarUrl: row.comment.authorAvatarUrl,
    isMine: !!currentUserId && row.comment.userId === currentUserId,
  };
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    const [item] = await db
      .select({ id: productionItems.id })
      .from(productionItems)
      .where(eq(productionItems.id, id))
      .limit(1);
    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    const rows = await db
      .select({ comment: contentComments, user: users })
      .from(contentComments)
      .leftJoin(users, eq(users.id, contentComments.userId))
      .where(eq(contentComments.contentItemId, id))
      .orderBy(asc(contentComments.createdAt));

    const currentUserId = session.user.id ?? null;
    return NextResponse.json({
      comments: rows.map((r) => shape(r, currentUserId)),
    });
  } catch (error) {
    console.error("Error fetching comments:", error);
    return NextResponse.json(
      { error: "Failed to fetch comments" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
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
    // Image-only / file-only comments are valid — `plain` is empty but
    // the comment carries an `<img>` or anchor that the renderer shows.
    const hasAttachment = /<(img|a)\b/i.test(sanitized);
    if (!plain && !hasAttachment) {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }

    const [item] = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        editorUserId: productionItems.editorUserId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, id))
      .limit(1);
    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    const [inserted] = await db
      .insert(contentComments)
      .values({
        contentItemId: id,
        userId: session.user.id,
        body: sanitized,
      })
      .returning();

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    // Notify @-mentioned users first (higher priority than the generic comment
    // notification). Self-notification is filtered inside enqueueNotification.
    const excerpt = plain.slice(0, 240);
    const authorName = user?.name || user?.email || null;
    const mentionIds = new Set(extractMentionUserIds(sanitized));
    for (const mentionedId of mentionIds) {
      void enqueueNotification({
        userId: mentionedId,
        kind: "mention",
        contentItemId: id,
        commentId: inserted.id,
        actorUserId: session.user.id,
        payload: {
          kind: "mention",
          title: item.title,
          excerpt,
          authorName,
        },
      }).catch((err) => console.error("[comment] mention notify failed", err));
    }

    // Thread-participation rule (GitHub-style): notify the current editor plus
    // anyone who has previously commented on this item. People who never
    // engaged with the item drop out — fixes the legacy "phantom comments" the
    // fallback-producer was getting.
    const priorAuthorRows = await db
      .selectDistinct({ userId: contentComments.userId })
      .from(contentComments)
      .where(
        and(
          eq(contentComments.contentItemId, id),
          isNotNull(contentComments.userId),
        ),
      );
    const recipientIds = new Set<string>();
    if (item.editorUserId) recipientIds.add(item.editorUserId);
    for (const row of priorAuthorRows) {
      if (row.userId) recipientIds.add(row.userId);
    }
    for (const recipientId of recipientIds) {
      if (mentionIds.has(recipientId)) continue;
      void enqueueNotification({
        userId: recipientId,
        kind: "comment",
        contentItemId: id,
        commentId: inserted.id,
        actorUserId: session.user.id,
        payload: {
          kind: "comment",
          title: item.title,
          excerpt,
          authorName,
        },
      }).catch((err) => console.error("[comment] notify failed", err));
    }

    return NextResponse.json(
      { comment: shape({ comment: inserted, user: user ?? null }, session.user.id) },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating comment:", error);
    return NextResponse.json(
      { error: "Failed to create comment" },
      { status: 500 },
    );
  }
}
