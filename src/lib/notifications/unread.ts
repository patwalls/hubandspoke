// The bell's red badge counts what is new to you, not your whole history.
//
// Before 2026-11-25 a notification only became "read" when you clicked it in the
// bell, so people who work from the notification emails (most of the team)
// piled up hundreds of unread rows and the badge sat on "99+" for months —
// a badge that never moves says nothing. Two rules fix that:
//   1. Opening a post marks your notifications about that post read
//      (`useMarkPostNotificationsRead` → POST /api/notifications/mark-read
//      { contentItemId }).
//   2. The badge only counts unread rows from the last BADGE_WINDOW_DAYS.
//      Older unread rows still show (highlighted) in the bell list and on
//      /notifications; they just stop shouting.

export const BADGE_WINDOW_DAYS = 14;

/** Oldest createdAt that still counts toward the bell badge. */
export function badgeWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - BADGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Window event the bell listens to so it refetches right after a mark-read. */
export const NOTIFICATIONS_CHANGED_EVENT = "notifications:changed";

export type MarkReadBody =
  | { kind: "all" }
  | { kind: "ids"; ids: string[] }
  | { kind: "item"; contentItemId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the mark-read request body. `{ all: true }` clears the inbox,
 * `{ ids }` dismisses specific rows (a bell click), `{ contentItemId }` clears
 * everything about one post (opening it). Anything else → null (400).
 */
export function parseMarkReadBody(body: unknown): MarkReadBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.all === true) return { kind: "all" };
  if (typeof b.contentItemId === "string") {
    return UUID_RE.test(b.contentItemId)
      ? { kind: "item", contentItemId: b.contentItemId }
      : null;
  }
  if (Array.isArray(b.ids)) {
    const ids = b.ids.filter((v): v is string => typeof v === "string");
    return ids.length > 0 ? { kind: "ids", ids } : null;
  }
  return null;
}
