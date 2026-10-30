import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { listUsers } from "@/lib/api/catalog";
import { apiJson, parseQuery, zBool } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const Query = z.object({ include_inactive: zBool.optional() });

export const GET = v1Handler("/v1/users", async ({ url }) => apiJson(await listUsers(parseQuery(url, Query))));
