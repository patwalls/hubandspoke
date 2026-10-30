import { NextResponse } from "next/server";
import { baseUrlFrom } from "@/lib/api/base-url";
import { buildOpenApiDocument } from "@/lib/api/openapi";

export const dynamic = "force-dynamic";

/** GET /api/v1/openapi.json — public; the spec has no secrets and tools import it by URL. */
export async function GET(request: Request) {
  return NextResponse.json(buildOpenApiDocument(baseUrlFrom(request)), {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
