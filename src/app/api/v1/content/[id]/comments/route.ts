import { z } from "zod";
import { requireScope, v1Handler } from "@/lib/api/auth";
import { listComments } from "@/lib/api/content";
import { apiJson, idFromPath, readJson } from "@/lib/api/http";
import { addComment } from "@/lib/api/writes";

export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().min(1).max(5000), at_sec: z.number().min(0).nullable().optional() });

export const GET = v1Handler("/v1/content/{id}/comments", async ({ url }) => {
  const id = idFromPath(url, "content");
  return apiJson(await listComments(id));
});

/** POST — add a comment as the key's owner. Needs the `write` scope. */
export const POST = v1Handler("/v1/content/{id}/comments", async ({ url, request, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "content");
  const body = Body.parse(await readJson(request));
  return apiJson({ data: await addComment(principal, id, body) }, { status: 201 });
});
