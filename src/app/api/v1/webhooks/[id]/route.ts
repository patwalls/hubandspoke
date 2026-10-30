import { z } from "zod";
import { requireScope, v1Handler } from "@/lib/api/auth";
import { apiJson, idFromPath, readJson } from "@/lib/api/http";
import { deleteWebhook, setWebhookActive } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const Body = z.object({ active: z.boolean() });

/** PATCH /api/v1/webhooks/{id} — pause or resume. Needs `write`. */
export const PATCH = v1Handler("/v1/webhooks/{id}", async ({ url, request, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "webhooks");
  const body = Body.parse(await readJson(request));
  const isAdmin = principal.user.role === "admin";
  return apiJson({ data: await setWebhookActive({ id, userId: principal.user.id, isAdmin, active: body.active }) });
});

/** DELETE /api/v1/webhooks/{id} — remove the subscription and its delivery history. Needs `write`. */
export const DELETE = v1Handler("/v1/webhooks/{id}", async ({ url, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "webhooks");
  await deleteWebhook({ id, userId: principal.user.id, isAdmin: principal.user.role === "admin" });
  return apiJson({ data: { id, deleted: true } });
});
