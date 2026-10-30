import { requireScope, v1Handler } from "@/lib/api/auth";
import { apiJson, idFromPath } from "@/lib/api/http";
import { getWebhookForUser } from "@/lib/api/webhooks";
import { db } from "@/lib/db";
import { apiWebhookDeliveries } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { DELIVERY_MAX_ATTEMPTS } from "@/lib/services/webhook-dispatch";

export const dynamic = "force-dynamic";

/** POST /api/v1/webhooks/{id}/test — queue a `ping` delivery so you can check your receiver. Needs `write`. */
export const POST = v1Handler("/v1/webhooks/{id}/test", async ({ url, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "webhooks");
  const hook = await getWebhookForUser(id, principal.user.id, principal.user.role === "admin");
  const [row] = await db
    .insert(apiWebhookDeliveries)
    .values({ webhookId: hook.id, event: "ping", payload: { message: "Hello from Hub & Spoke", webhook_id: hook.id } })
    .returning();
  await enqueue("webhook-deliver", { deliveryId: row.id }, { maxAttempts: DELIVERY_MAX_ATTEMPTS, jobKey: `webhook-deliver:${row.id}` });
  return apiJson({ data: { delivery_id: row.id, status: "pending" } }, { status: 202 });
});
