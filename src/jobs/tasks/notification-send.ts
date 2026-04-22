import type { Task } from "graphile-worker";
import { sendEmailForNotification } from "@/lib/services/notifications";

export interface NotificationSendPayload {
  notificationId: string;
}

/**
 * Re-fetches the notification row and dispatches the matching Postmark email.
 * Payload stays tiny (one id) so the queue doesn't hold stale copies of
 * comment bodies.
 */
export const notificationSendTask: Task = async (rawPayload, helpers) => {
  const { notificationId } = rawPayload as NotificationSendPayload;
  await sendEmailForNotification(notificationId);
  helpers.logger.info(`notification-send ok id=${notificationId}`);
};
