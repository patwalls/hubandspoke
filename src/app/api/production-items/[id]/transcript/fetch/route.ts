import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import {
  fetchDescriptTranscript,
  TranscriptFetchError,
} from "@/lib/services/transcript-fetch";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Long-running: publish job polling can take up to ~3 minutes.
export const maxDuration = 300;

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  try {
    const result = await fetchDescriptTranscript(id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof TranscriptFetchError ? err.kind : "unknown";
    const status =
      kind === "no_descript_project" || kind === "no_composition"
        ? 400
        : kind === "publish_timeout"
          ? 504
          : 502;
    return NextResponse.json({ ok: false, error: message, kind }, { status });
  }
}
