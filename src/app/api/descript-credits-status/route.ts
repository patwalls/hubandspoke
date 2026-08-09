import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getDescriptCreditsExhaustionState } from "@/lib/services/descript-credits-watch";
import { requireSession } from "@/lib/auth-guards";

/**
 * Polled by the dashboard banner. Returns the current Descript AI-
 * credit exhaustion state derived from `graphile_worker.jobs` rows in
 * the last hour. Cheap query — single COUNT over the view, safe to
 * call every page load.
 */
// Global state polled by the banner on every page load — cache 60s (same
// rationale as sc-credits-status).
const getStateCached = unstable_cache(
  async () => getDescriptCreditsExhaustionState(),
  ["descript-credits-status"],
  { revalidate: 60 },
);

export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const state = await getStateCached();
  return NextResponse.json(state);
}
