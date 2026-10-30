import type { Task } from "graphile-worker";
import { deliverWebhook } from "@/lib/services/webhook-dispatch";

export interface WebhookDeliverPayload {
  deliveryId: string;
}

/**
 * POST one `api_webhook_deliveries` row to its subscriber. Throws on a
 * non-2xx or network error so graphile-worker retries with backoff (up to
 * the job's max_attempts, set by the sweep). See webhook-dispatch.ts.
 */
export const webhookDeliverTask: Task = async (rawPayload, helpers) => {
  const { deliveryId } = rawPayload as WebhookDeliverPayload;
  await deliverWebhook(deliveryId, helpers.job.attempts, helpers.job.max_attempts, helpers.abortSignal);
};
