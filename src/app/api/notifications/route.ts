import { NextRequest, NextResponse } from "next/server";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  notifications,
  productionItems,
  users,
  type NotificationPayload,
} from "@/lib/db/schema";
import { auth } from "@/lib/auth";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Math.min(Math.max(1, limitParam), MAX_LIMIT);
  const unreadOnly = url.searchParams.get("unread") === "1";

  const where = unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      contentItemId: notifications.contentItemId,
      commentId: notifications.commentId,
      actorUserId: notifications.actorUserId,
      payload: notifications.payload,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      itemTitle: productionItems.title,
      itemBrand: productionItems.brand,
      actorName: users.name,
      actorEmail: users.email,
      actorAvatarUrl: users.avatarUrl,
    })
    .from(notifications)
    .leftJoin(
      productionItems,
      eq(productionItems.id, notifications.contentItemId)
    )
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const [{ value: unreadCount }] = await db
    .select({ value: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt))
    );

  return NextResponse.json({
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: r.payload as NotificationPayload,
      contentItemId: r.contentItemId,
      commentId: r.commentId,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      item: r.contentItemId
        ? { id: r.contentItemId, title: r.itemTitle, brand: r.itemBrand }
        : null,
      actor: r.actorUserId
        ? {
            id: r.actorUserId,
            name: r.actorName,
            email: r.actorEmail,
            avatarUrl: r.actorAvatarUrl,
          }
        : null,
    })),
    unreadCount: Number(unreadCount),
  });
}
