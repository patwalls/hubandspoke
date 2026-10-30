import { z } from "zod";
import { requireScope, v1Handler } from "@/lib/api/auth";
import { apiJson, idFromPath } from "@/lib/api/http";
import { decideClipIdea } from "@/lib/api/writes";

export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.string().max(2000).nullable().optional() });

/** POST /api/v1/clip-ideas/{id}/kill — reject a suggested clip. Needs `write`. */
export const POST = v1Handler("/v1/clip-ideas/{id}/kill", async ({ url, request, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "clip-ideas");
  const text = await request.text();
  const body = Body.parse(text.trim() ? JSON.parse(text) : {});
  return apiJson({ data: await decideClipIdea(principal, id, { action: "kill", reason: body.reason }) });
});
