import { NextResponse } from "next/server";
import { getDescriptCreditsExhaustionState } from "@/lib/services/descript-credits-watch";
import { requireSession } from "@/lib/auth-guards";

/**
 * Polled by the dashboard banner. Returns the current Descript AI-
 * credit exhaustion state derived from `graphile_worker.jobs` rows in
 * the last hour. Cheap query — single COUNT over the view, safe to
 * call every page load.
 */
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const state = await getDescriptCreditsExhaustionState();
  return NextResponse.json(state);
}
