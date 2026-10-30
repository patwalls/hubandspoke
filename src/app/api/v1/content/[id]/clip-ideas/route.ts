import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { listClipIdeas } from "@/lib/api/content";
import { apiJson, parseQuery, idFromPath } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const Query = z.object({ status: z.enum(["suggested", "accepted", "killed"]).optional() });

export const GET = v1Handler("/v1/content/{id}/clip-ideas", async ({ url }) => {
  const id = idFromPath(url, "content");
  const q = parseQuery(url, Query);
  return apiJson(await listClipIdeas(id, q));
});
