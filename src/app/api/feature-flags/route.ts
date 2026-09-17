import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { resolveFeatureFlags } from "@/lib/feature-flags";

/** Which feature flags are on for the signed-in user. Booleans only — the
 *  allowlists themselves never leave the server. */
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  return NextResponse.json(
    { flags: resolveFeatureFlags(guard.session.user) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
