import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { listAccounts } from "@/lib/api/catalog";
import { apiJson, parseQuery, zBool } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const Query = z.object({
  brand: z.string().max(60).optional(),
  platform: z.string().max(30).optional(),
  include_inactive: zBool.optional(),
});

export const GET = v1Handler("/v1/accounts", async ({ url }) => {
  const q = parseQuery(url, Query);
  return apiJson(await listAccounts(q));
});
