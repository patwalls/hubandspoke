import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { listFormats } from "@/lib/api/catalog";
import { apiJson, parseQuery } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const Query = z.object({ brand: z.string().max(60).optional() });

export const GET = v1Handler("/v1/formats", async ({ url }) => {
  const q = parseQuery(url, Query);
  return apiJson(await listFormats(q));
});
