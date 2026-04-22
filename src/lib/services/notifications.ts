import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  notifications,
  productionItems,
  users,
  type NotificationPayload,
} from "@/lib/db/schema";
import {
  sendAssignmentEmail,
  sendCommentEmail,
  sendMentionEmail,
} from "@/lib/email";
import { enqueue } from "@/jobs/enqueue";

type EnqueueInput = {
  userId: string;
  kind: NotificationPayload["kind"];
  contentItemId?: string | null;
  commentId?: string | null;
  actorUserId?: string | null;
  payload: NotificationPayload;
};

function appBaseUrl(): string {
  // NEXTAUTH_URL is the single env that's already set everywhere the app runs
  // (local, Heroku). Falling back to relative paths in email would be useless.
  return (
    process.env.NEXTAUTH_URL?.replace(/\/$/, "") || "http://localhost:3000"
  );
}

function itemUrl(brand: string, contentItemId: string): string {
  return `${appBaseUrl()}/${brand}/content/${contentItemId}`;
}

// Inserts a notification row and enqueues the matching email send on the
// background job queue. Skips self-notifications and users without a
// passwordHash (uninvited contractors synced from Notion).
export async function enqueueNotification(input: EnqueueInput): Promise<void> {
  if (input.actorUserId && input.actorUserId === input.userId) return;

  const [recipient] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!recipient) return;

  const [inserted] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind,
      contentItemId: input.contentItemId ?? null,
      commentId: input.commentId ?? null,
      actorUserId: input.actorUserId ?? null,
      payload: input.payload,
    })
    .returning({ id: notifications.id });

  if (!recipient.passwordHash) return;
  if (!inserted) return;

  await enqueue("notification-send", { notificationId: inserted.id });
}

/**
 * Reconstruct the email payload from a notification row and send it. Exported
 * so the `notification-send` Graphile Worker task can re-deliver after a
 * retry without stashing PII in the queue payload.
 *
 * Idempotent: skips if `emailedAt` is already set.
 */
export async function sendEmailForNotification(
  notificationId: string,
): Promise<void> {
  const [row] = await db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      contentItemId: notifications.contentItemId,
      actorUserId: notifications.actorUserId,
      payload: notifications.payload,
      emailedAt: notifications.emailedAt,
    })
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1);
  if (!row || row.emailedAt) return;

  const [recipient] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!recipient) return;

  let brand = "starter-story";
  if (row.contentItemId) {
    const [item] = await db
      .select({ brand: productionItems.brand })
      .from(productionItems)
      .where(eq(productionItems.id, row.contentItemId))
      .limit(1);
    if (item) brand = item.brand;
  }

  const url = row.contentItemId
    ? itemUrl(brand, row.contentItemId)
    : appBaseUrl();

  let assignerName: string | null = null;
  if (row.actorUserId) {
    const [actor] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, row.actorUserId))
      .limit(1);
    assignerName = actor?.name || actor?.email || null;
  }

  const payload = row.payload as NotificationPayload;
  if (payload.kind === "assigned") {
    await sendAssignmentEmail({
      to: recipient.email,
      name: recipient.name,
      itemTitle: payload.title,
      role: payload.role,
      assignedByName: assignerName,
      itemUrl: url,
    });
  } else if (payload.kind === "comment") {
    await sendCommentEmail({
      to: recipient.email,
      name: recipient.name,
      itemTitle: payload.title,
      commentAuthor: payload.authorName || assignerName,
      commentBody: payload.excerpt,
      itemUrl: url,
    });
  } else if (payload.kind === "mention") {
    await sendMentionEmail({
      to: recipient.email,
      name: recipient.name,
      itemTitle: payload.title,
      commentAuthor: payload.authorName || assignerName,
      commentBody: payload.excerpt,
      itemUrl: url,
    });
  }

  await db
    .update(notifications)
    .set({ emailedAt: new Date() })
    .where(eq(notifications.id, notificationId));
}
