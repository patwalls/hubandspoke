import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  contentComments,
  contentEvents,
  productionItems,
  users,
  type ContentEventPayload,
} from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

interface RouteContext {
  params: Promise<{ id: string }>;
}

type CommentRow = typeof contentComments.$inferSelect;
type EventRow = typeof contentEvents.$inferSelect;
type UserRow = typeof users.$inferSelect;

const resolvers = alias(users, "resolvers");

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
  resolvedByName: string | null,
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
    atSeconds: comment.atSeconds,
    resolvedAt: comment.resolvedAt ? comment.resolvedAt.toISOString() : null,
    resolvedByName,
    // Closed by a clip editor re-render rather than by hand (review-notes M4).
    resolvedByRender: !!comment.resolvedByRenderId,
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
    const guard = await requireSession();
    if (guard.response) return guard.response;
    const session = guard.session;
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
        .select({
          comment: contentComments,
          user: users,
          resolvedByName: resolvers.name,
        })
        .from(contentComments)
        .leftJoin(users, eq(users.id, contentComments.userId))
        .leftJoin(resolvers, eq(resolvers.id, contentComments.resolvedByUserId))
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
      ...commentRows.map((r) => shapeComment(r.comment, r.user, currentUserId, r.resolvedByName)),
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
