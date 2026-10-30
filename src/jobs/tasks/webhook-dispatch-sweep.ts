import type { Task } from "graphile-worker";
import { runWebhookDispatchSweep } from "@/lib/services/webhook-dispatch";

/**
 * Every minute: diff production_items / transcripts against the last-seen
 * state and queue `webhook-deliver` jobs for every matching subscription.
 * Two indexed range scans when idle. See webhook-dispatch.ts.
 */
export const webhookDispatchSweepTask: Task = async (_payload, helpers) => {
  const r = await runWebhookDispatchSweep();
  if (r.events || r.deliveries) helpers.logger.info(`webhook-dispatch-sweep events=${r.events} deliveries=${r.deliveries}`);
};
