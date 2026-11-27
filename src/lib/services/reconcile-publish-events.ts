import type { ContentChange } from "@/lib/services/content-revisions";

export interface ReconcileSide {
  status: string | null;
  publishedLink: string | null;
  publishedDate: string | null;
}

/**
 * What the activity trail should record when a synced live post is folded
 * into the planning item (reconcileScheduledIntoPublished).
 *
 * The planning item is often already Published by then: someone pasted the
 * link in the Publish dialog, which flipped the status and fired the sync
 * that found the live post. Recording the flip again wrote "changed status
 * from Published to Published" into the post's Activity (and a second
 * status_change row for every count that reads them). Only real changes go in.
 */
export function reconcilePublishChanges(
  planned: ReconcileSide,
  synced: Pick<ReconcileSide, "publishedLink" | "publishedDate">,
): {
  changes: ContentChange[];
  statusChange: { from: string | null; to: "Published" } | null;
} {
  const changes: ContentChange[] = [];
  const statusChanged = planned.status !== "Published";
  if (statusChanged) {
    changes.push({
      target: { kind: "production_item_field", field: "status" },
      from: planned.status,
      to: "Published",
    });
  }
  if (planned.publishedLink !== synced.publishedLink) {
    changes.push({
      target: { kind: "production_item_field", field: "publishedLink" },
      from: planned.publishedLink,
      to: synced.publishedLink,
    });
  }
  if (planned.publishedDate !== synced.publishedDate) {
    changes.push({
      target: { kind: "production_item_field", field: "publishedDate" },
      from: planned.publishedDate,
      to: synced.publishedDate,
    });
  }
  return {
    changes,
    statusChange: statusChanged
      ? { from: planned.status, to: "Published" }
      : null,
  };
}

/**
 * A status_change row whose from and to are the same status. Older rows like
 * this exist (written before reconcilePublishChanges); the post's Activity
 * skips them rather than show "from Published to Published".
 */
export function isNoopStatusChange(payload: {
  type: string;
  from?: unknown;
  to?: unknown;
}): boolean {
  return (
    payload.type === "status_change" &&
    payload.from != null &&
    payload.from === payload.to
  );
}
