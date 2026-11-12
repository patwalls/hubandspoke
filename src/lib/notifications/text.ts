import type { NotificationPayload } from "@/lib/db/schema";
import { formatLift } from "@/lib/winners/pick";

/**
 * The words the bell popover and /notifications show for one notification:
 * a small headline ("Sam assigned this to you") and, when there is one, a
 * second line under the post title (a comment's excerpt, a win's "why").
 * One place so the two lists can't drift.
 */
export function notificationText(
  payload: NotificationPayload,
  actorName: string,
): { headline: string; excerpt: string | null } {
  switch (payload.kind) {
    case "assigned":
      return { headline: `${actorName} assigned this to you`, excerpt: null };
    case "comment":
      return { headline: `${actorName} commented`, excerpt: payload.excerpt };
    case "mention":
      return { headline: `${actorName} mentioned you`, excerpt: payload.excerpt };
    case "win":
      return {
        headline: `A post you edited beat its usual · ${formatLift(payload.lift)}`,
        excerpt: payload.note || null,
      };
    default:
      return { headline: "Update", excerpt: null };
  }
}
