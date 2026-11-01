import { z } from "zod";
import { requireScope, v1Handler } from "@/lib/api/auth";
import { WEBHOOK_EVENTS } from "@/lib/api/constants";
import { apiJson, readJson } from "@/lib/api/http";
import { createWebhook, listWebhooks, validateEvents, validateWebhookUrl } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().min(1).max(60),
  url: z.string().min(8),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  brand: z.string().max(60).nullable().optional(),
});

/** GET /api/v1/webhooks — your subscriptions (admins: `?all=1` for everyone's). */
export const GET = v1Handler("/v1/webhooks", async ({ url, principal }) => {
  const all = url.searchParams.get("all") === "1" && principal.user.role === "admin";
  return apiJson({ data: await listWebhooks({ userId: principal.user.id, all }) });
});

/** POST /api/v1/webhooks — subscribe a URL. The signing secret is returned once. Needs `write`. */
export const POST = v1Handler("/v1/webhooks", async ({ request, principal }) => {
  requireScope(principal, "write");
  const body = Body.parse(await readJson(request));
  const { webhook, secret } = await createWebhook({
    userId: principal.user.id,
    name: body.name,
    url: await validateWebhookUrl(body.url),
    events: validateEvents(body.events),
    brand: body.brand ?? null,
  });
  return apiJson({ data: { ...webhook, secret } }, { status: 201 });
});
