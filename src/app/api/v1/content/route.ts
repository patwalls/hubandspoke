import { z } from "zod";
import { requireScope, v1Handler } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { ContentListQuery, listContent } from "@/lib/api/content";
import { apiJson, parseQuery, readJson } from "@/lib/api/http";
import { createContentFromLink } from "@/lib/api/writes";

const CreateBody = z.object({
  url: z.string().url(),
  brand: z.string().min(1).max(60),
  title: z.string().max(500).optional(),
  format: z.string().max(120).optional(),
  editor_id: z.uuid().optional(),
});

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/content", async ({ url, request }) => {
  const q = parseQuery(url, ContentListQuery);
  return apiJson(await listContent(q, baseUrlFrom(request)));
});

/** POST /api/v1/content — add a live post by URL (the API twin of "Add from link"). Needs the `write` scope. */
export const POST = v1Handler("/v1/content", async ({ request, principal }) => {
  requireScope(principal, "write");
  const body = CreateBody.parse(await readJson(request));
  return apiJson({ data: await createContentFromLink(principal, body, baseUrlFrom(request)) }, { status: 201 });
});
