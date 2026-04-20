import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  contentComments,
  contentEvents,
  productionItems,
  users,
  type ContentEventPayload,
} from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

type CommentRow = typeof contentComments.$inferSelect;
type EventRow = typeof contentEvents.$inferSelect;
type UserRow = typeof users.$inferSelect;

function shapeUser(user: UserRow | null) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}

function shapeComment(
  comment: CommentRow,
  user: UserRow | null,
  currentUserId: string | null,
) {
  return {
    kind: "comment" as const,
    id: comment.id,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
    body: comment.body,
    user: shapeUser(user),
    authorName: comment.authorName,
    authorAvatarUrl: comment.authorAvatarUrl,
    isMine: !!currentUserId && comment.userId === currentUserId,
  };
}

function shapeEvent(event: EventRow, user: UserRow | null) {
  return {
    kind: "event" as const,
    id: event.id,
    createdAt: event.createdAt.toISOString(),
    eventType: event.eventType,
    payload: event.payload as ContentEventPayload,
    user: shapeUser(user),
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

    const currentUserId = session.user.id ?? null;

    const [commentRows, eventRows] = await Promise.all([
      db
        .select({ comment: contentComments, user: users })
        .from(contentComments)
        .leftJoin(users, eq(users.id, contentComments.userId))
        .where(eq(contentComments.contentItemId, id))
        .orderBy(asc(contentComments.createdAt)),
      db
        .select({ event: contentEvents, user: users })
        .from(contentEvents)
        .leftJoin(users, eq(users.id, contentEvents.userId))
        .where(eq(contentEvents.contentItemId, id))
        .orderBy(asc(contentEvents.createdAt)),
    ]);

    const items = [
      ...commentRows.map((r) => shapeComment(r.comment, r.user, currentUserId)),
      ...eventRows.map((r) => shapeEvent(r.event, r.user)),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return NextResponse.json({ items });
  } catch (error) {
    console.error("Error fetching activity:", error);
    return NextResponse.json(
      { error: "Failed to fetch activity" },
      { status: 500 },
    );
  }
}
