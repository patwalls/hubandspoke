import { describe, it, expect } from "vitest";
import { toNotificationItem, type NotificationRow } from "./to-item";

// Cross-posts share their post's title, so the bell can only tell an
// assignment for the Instagram Reel from the TikTok if the API carries the
// item's postType through to the row.
const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "n1",
  kind: "assigned",
  contentItemId: "item-1",
  commentId: null,
  actorUserId: "u2",
  payload: { kind: "assigned", title: "Same title" },
  readAt: null,
  createdAt: new Date("2026-10-26T12:00:00Z"),
  itemTitle: "Same title",
  itemBrand: "starter-story",
  itemPostType: "instagram_reel",
  actorName: "A teammate",
  actorEmail: null,
  actorAvatarUrl: null,
  ...over,
});

describe("toNotificationItem", () => {
  it("carries the item's postType so same-titled cross-posts differ", () => {
    const reel = toNotificationItem(row());
    const tiktok = toNotificationItem(row({ id: "n2", contentItemId: "item-2", itemPostType: "tiktok" }));
    expect(reel.item?.title).toBe(tiktok.item?.title);
    expect(reel.item?.postType).toBe("instagram_reel");
    expect(tiktok.item?.postType).toBe("tiktok");
  });

  it("has no item when the notification has no content item", () => {
    expect(toNotificationItem(row({ contentItemId: null })).item).toBeNull();
  });
});
