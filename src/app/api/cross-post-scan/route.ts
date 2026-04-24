import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { runCrossPostScan } from "@/lib/services/cross-post-scan";

// Manual trigger for the cross-post scanner. Invoked by the "Populate
// queue" button in /[brand]/queue under the Cross-post tab. The scanner is
// NOT on cron — this is the only path that creates cross-post Ideas.
//
// POST /api/cross-post-scan
// body (optional): { maxCandidates?: number; maxIdeas?: number }
// defaults: maxCandidates=20, maxIdeas=10

const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_MAX_IDEAS = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let maxCandidates = DEFAULT_MAX_CANDIDATES;
  let maxIdeas = DEFAULT_MAX_IDEAS;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      maxCandidates?: unknown;
      maxIdeas?: unknown;
    };
    if (typeof body.maxCandidates === "number" && body.maxCandidates > 0) {
      maxCandidates = Math.min(100, Math.floor(body.maxCandidates));
    }
    if (typeof body.maxIdeas === "number" && body.maxIdeas > 0) {
      maxIdeas = Math.min(50, Math.floor(body.maxIdeas));
    }
  } catch {
    // ignore body parse errors; fall back to defaults
  }

  try {
    const result = await runCrossPostScan({ maxCandidates, maxIdeas });
    return NextResponse.json({
      ok: true,
      maxCandidates,
      maxIdeas,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("cross-post-scan manual run failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
