import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import {
  fetchInstagramBody,
  InstagramBodyFetchError,
} from "@/lib/services/instagram-body-fetch";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// With download_media=true, SC can take a while to stage the file.
export const maxDuration = 120;

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const withMedia = request.nextUrl.searchParams.get("withMedia") === "true";

  try {
    const result = await fetchInstagramBody(id, { withMedia });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind =
      err instanceof InstagramBodyFetchError ? err.kind : "unknown";
    const status =
      kind === "not_found"
        ? 404
        : kind === "no_link" || kind === "not_an_instagram_url"
          ? 400
          : 502;
    return NextResponse.json({ ok: false, error: message, kind }, { status });
  }
}
