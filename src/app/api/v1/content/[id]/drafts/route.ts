import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { listDrafts } from "@/lib/api/content";
import { apiJson, idFromPath, parseQuery, zBool } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const Query = z.object({ current_only: zBool.optional() });

export const GET = v1Handler("/v1/content/{id}/drafts", async ({ url }) => {
  const id = idFromPath(url, "content");
  return apiJson(await listDrafts(id, parseQuery(url, Query)));
});
