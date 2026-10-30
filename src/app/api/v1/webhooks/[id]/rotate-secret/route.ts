import { requireScope, v1Handler } from "@/lib/api/auth";
import { apiJson, idFromPath } from "@/lib/api/http";
import { rotateWebhookSecret } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

/** POST /api/v1/webhooks/{id}/rotate-secret — new signing secret, returned once. Needs `write`. */
export const POST = v1Handler("/v1/webhooks/{id}/rotate-secret", async ({ url, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "webhooks");
  const secret = await rotateWebhookSecret({ id, userId: principal.user.id, isAdmin: principal.user.role === "admin" });
  return apiJson({ data: { id, secret } });
});
