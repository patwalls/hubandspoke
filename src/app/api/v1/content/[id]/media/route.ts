import { v1Handler } from "@/lib/api/auth";
import { listMedia } from "@/lib/api/content";
import { apiJson, idFromPath } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export const GET = v1Handler("/v1/content/{id}/media", async ({ url }) => {
  const id = idFromPath(url, "content");
  return apiJson(await listMedia(id));
});
