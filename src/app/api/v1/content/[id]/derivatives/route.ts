import { v1Handler } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { listDerivatives } from "@/lib/api/content";
import { apiJson, idFromPath } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/content/{id}/derivatives", async ({ url, request }) => {
  const id = idFromPath(url, "content");
  return apiJson(await listDerivatives(id, baseUrlFrom(request)));
});
