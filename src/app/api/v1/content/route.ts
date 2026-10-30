import { v1Handler } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { ContentListQuery, listContent } from "@/lib/api/content";
import { apiJson, parseQuery } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/content", async ({ url, request }) => {
  const q = parseQuery(url, ContentListQuery);
  return apiJson(await listContent(q, baseUrlFrom(request)));
});
