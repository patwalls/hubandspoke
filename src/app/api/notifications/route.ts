import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  notifications,
  productionItems,
  users,
} from "@/lib/db/schema";
import { toNotificationItem } from "@/lib/notifications/to-item";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const session = guard.session;

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
      itemPostType: productionItems.postType,
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
    items: rows.map(toNotificationItem),
    unreadCount: Number(unreadCount),
  });
}
