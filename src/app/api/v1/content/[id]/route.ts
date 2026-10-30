import { v1Handler } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { getContent } from "@/lib/api/content";
import { apiJson, idFromPath } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/content/{id}", async ({ url, request }) => {
  const id = idFromPath(url, "content");
  return apiJson({ data: await getContent(id, baseUrlFrom(request)) });
});
