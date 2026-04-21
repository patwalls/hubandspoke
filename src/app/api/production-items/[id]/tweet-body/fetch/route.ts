import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import {
  fetchTweetBody,
  TweetBodyFetchError,
} from "@/lib/services/tweet-body-fetch";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  try {
    const result = await fetchTweetBody(id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof TweetBodyFetchError ? err.kind : "unknown";
    const status =
      kind === "not_found"
        ? 404
        : kind === "no_link" || kind === "not_a_tweet"
          ? 400
          : 502;
    return NextResponse.json({ ok: false, error: message, kind }, { status });
  }
}
