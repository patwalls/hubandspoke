import type { NotificationPayload } from "@/lib/db/schema";

/**
 * One row of `GET /api/notifications`, as the header bell reads it.
 *
 * `item.postType` is there because cross-posts share their post's title: an
 * assignment for one post's Instagram Reel and its TikTok read the same in the
 * bell without it, and a same-titled click once moved a Published post back.
 */
export type NotificationItem = {
  id: string;
  kind: string;
  payload: NotificationPayload;
  contentItemId: string | null;
  commentId: string | null;
  readAt: string | null;
  createdAt: string;
  item: {
    id: string;
    title: string | null;
    brand: string;
    postType: string | null;
  } | null;
  actor: {
    id: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  } | null;
};

/** The route's joined select (notifications ⟕ production_items ⟕ users). */
export interface NotificationRow {
  id: string;
  kind: string;
  contentItemId: string | null;
  commentId: string | null;
  actorUserId: string | null;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
  itemTitle: string | null;
  itemBrand: string | null;
  itemPostType: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorAvatarUrl: string | null;
}

export function toNotificationItem(r: NotificationRow): NotificationItem {
  return {
    id: r.id,
    kind: r.kind,
    payload: r.payload as NotificationPayload,
    contentItemId: r.contentItemId,
    commentId: r.commentId,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    item: r.contentItemId
      ? {
          id: r.contentItemId,
          title: r.itemTitle,
          brand: r.itemBrand ?? "",
          postType: r.itemPostType,
        }
      : null,
    actor: r.actorUserId
      ? {
          id: r.actorUserId,
          name: r.actorName,
          email: r.actorEmail,
          avatarUrl: r.actorAvatarUrl,
        }
      : null,
  };
}
