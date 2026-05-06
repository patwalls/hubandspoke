import { NextResponse } from "next/server";
import { getScCreditsExhaustionState } from "@/lib/services/sc-credits-watch";
import { requireSession } from "@/lib/auth-guards";

/**
 * Polled by the dashboard banner. Returns the current Scrape Creators
 * credit-exhaustion state derived from `sc_call_log` rows in the last
 * hour. Cheap query — safe to call every page load.
 */
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const state = await getScCreditsExhaustionState();
  return NextResponse.json(state);
}
