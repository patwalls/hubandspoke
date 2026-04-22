import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import {
  startDescriptTranscriptFetch,
  TranscriptFetchError,
} from "@/lib/services/transcript-fetch";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  // Kick off the Descript publish synchronously so we can surface validation
  // errors (no project, no composition, dry-run) to the client right away.
  let start;
  try {
    start = await startDescriptTranscriptFetch(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof TranscriptFetchError ? err.kind : "unknown";
    const status =
      kind === "no_descript_project" || kind === "no_composition" ? 400 : 502;
    return NextResponse.json({ ok: false, error: message, kind }, { status });
  }

  // Hand off the 30–180s publish-poll + subtitle ingest to Graphile Worker.
  // The dialog's client-side polling of GET /transcript detects completion.
  await enqueue("transcript-finish", {
    productionItemId: id,
    publishJobId: start.publishJobId,
    startedAtIso: start.startedAt.toISOString(),
  });

  return NextResponse.json(
    { ok: true, status: "pending", publishJobId: start.publishJobId },
    { status: 202 }
  );
}
