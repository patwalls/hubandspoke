import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  notifications,
  productionItems,
  users,
  type NotificationPayload,
} from "@/lib/db/schema";
import { sendAssignmentEmail, sendCommentEmail } from "@/lib/email";

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

// Inserts a notification row and fires the matching email (fire-and-forget).
// Skips self-notifications and users without a passwordHash (uninvited
// contractors synced from Notion). Email failures are swallowed so they
// never break the caller's request path.
export async function enqueueNotification(input: EnqueueInput): Promise<void> {
  if (input.actorUserId && input.actorUserId === input.userId) return;

  const [recipient] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
    })
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

  void sendEmailForNotification(inserted.id, input, recipient).catch((err) => {
    console.error("[notifications] email send failed", err);
  });
}

async function sendEmailForNotification(
  notificationId: string,
  input: EnqueueInput,
  recipient: { email: string; name: string | null },
): Promise<void> {
  let brand = "starter-story";
  if (input.contentItemId) {
    const [item] = await db
      .select({ brand: productionItems.brand })
      .from(productionItems)
      .where(eq(productionItems.id, input.contentItemId))
      .limit(1);
    if (item) brand = item.brand;
  }

  const url = input.contentItemId ? itemUrl(brand, input.contentItemId) : appBaseUrl();

  let assignerName: string | null = null;
  if (input.actorUserId) {
    const [actor] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.actorUserId))
      .limit(1);
    assignerName = actor?.name || actor?.email || null;
  }

  if (input.payload.kind === "assigned") {
    await sendAssignmentEmail({
      to: recipient.email,
      name: recipient.name,
      itemTitle: input.payload.title,
      role: input.payload.role,
      assignedByName: assignerName,
      itemUrl: url,
    });
  } else if (input.payload.kind === "comment") {
    await sendCommentEmail({
      to: recipient.email,
      name: recipient.name,
      itemTitle: input.payload.title,
      commentAuthor: input.payload.authorName || assignerName,
      commentBody: input.payload.excerpt,
      itemUrl: url,
    });
  }

  await db
    .update(notifications)
    .set({ emailedAt: new Date() })
    .where(eq(notifications.id, notificationId));
}
