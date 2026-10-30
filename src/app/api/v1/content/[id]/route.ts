import { z } from "zod";
import { requireScope, v1Handler } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { getContent } from "@/lib/api/content";
import { apiJson, idFromPath, readJson } from "@/lib/api/http";
import { updateContent } from "@/lib/api/writes";

const UpdateBody = z.object({
  status: z.string().max(60).optional(),
  editor_id: z.uuid().nullable().optional(),
  title: z.string().min(1).max(500).optional(),
  format: z.string().max(120).nullable().optional(),
  hub_id: z.uuid().nullable().optional(),
  kill_reason: z.string().max(2000).optional(),
  url: z.string().url().optional(),
  published_at: z.string().optional(),
});

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/content/{id}", async ({ url, request }) => {
  const id = idFromPath(url, "content");
  return apiJson({ data: await getContent(id, baseUrlFrom(request)) });
});

/** PATCH /api/v1/content/{id} — change status, editor, title, format or hub. Needs the `write` scope. */
export const PATCH = v1Handler("/v1/content/{id}", async ({ url, request, principal }) => {
  requireScope(principal, "write");
  const id = idFromPath(url, "content");
  const body = UpdateBody.parse(await readJson(request));
  return apiJson({ data: await updateContent(principal, id, body, baseUrlFrom(request)) });
});
