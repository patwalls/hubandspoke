import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getScCreditsExhaustionState } from "@/lib/services/sc-credits-watch";
import { requireSession } from "@/lib/auth-guards";

// Global (not per-user) state polled by the banner on EVERY page load —
// ~740ms each in prod, so cache 60s. A credit-exhaustion banner appearing
// up to a minute late is fine; it stays up for hours when real.
const getStateCached = unstable_cache(
  async () => getScCreditsExhaustionState(),
  ["sc-credits-status"],
  { revalidate: 60 },
);

/**
 * Polled by the dashboard banner. Returns the current Scrape Creators
 * credit-exhaustion state derived from `sc_call_log` rows in the last
 * hour. Cheap query — safe to call every page load.
 */
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const state = await getStateCached();
  return NextResponse.json(state);
}
