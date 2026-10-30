import { z } from "zod";
import { v1Handler } from "@/lib/api/auth";
import { baseUrlFrom } from "@/lib/api/base-url";
import { apiJson, parseQuery, zLimit } from "@/lib/api/http";
import { searchTranscripts } from "@/lib/api/transcript-search";

export const dynamic = "force-dynamic";

const Query = z.object({ q: z.string().min(2).max(200), brand: z.string().max(60).optional(), limit: zLimit(50, 20) });

export const GET = v1Handler("/v1/transcripts/search", async ({ url, request }) =>
  apiJson(await searchTranscripts(parseQuery(url, Query), baseUrlFrom(request))),
);
