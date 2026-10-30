import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { apiJson, idFromPath, parseQuery, zLimit } from "@/lib/api/http";
import { getWebhookForUser, listDeliveries } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const Query = z.object({ limit: zLimit(200, 50) });

/** GET /api/v1/webhooks/{id}/deliveries — recent deliveries with status and the last error. */
export const GET = v1Handler("/v1/webhooks/{id}/deliveries", async ({ url, principal }) => {
  const id = idFromPath(url, "webhooks");
  const isAdmin = principal.user.role === "admin";
  await getWebhookForUser(id, principal.user.id, isAdmin);
  const q = parseQuery(url, Query);
  return apiJson({ data: await listDeliveries({ userId: principal.user.id, webhookId: id, all: isAdmin, limit: q.limit }) });
});
