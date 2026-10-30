import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { listBrands } from "@/lib/api/catalog";
import { apiJson, parseQuery, zBool } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const Query = z.object({ include_disabled: zBool.optional() });

export const GET = v1Handler("/v1/brands", async ({ url }) => {
  const q = parseQuery(url, Query);
  return apiJson(await listBrands(q));
});
