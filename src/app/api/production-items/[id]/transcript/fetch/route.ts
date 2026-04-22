import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import {
  startDescriptTranscriptFetch,
  finishDescriptTranscriptFetch,
  TranscriptFetchError,
} from "@/lib/services/transcript-fetch";

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

  // Poll the publish job and ingest subtitles in the background. Heroku's
  // router times out at 30s but a publish job can take 30–180s, so we return
  // 202 now and let the client poll GET /transcript until the row lands. The
  // dyno's Node process keeps the promise alive until it resolves.
  finishDescriptTranscriptFetch(id, start.publishJobId, start.startedAt).catch(
    (err) => {
      console.error(
        `[transcript-fetch] background finish failed for item=${id} job=${start.publishJobId}:`,
        err
      );
    }
  );

  return NextResponse.json(
    { ok: true, status: "pending", publishJobId: start.publishJobId },
    { status: 202 }
  );
}
