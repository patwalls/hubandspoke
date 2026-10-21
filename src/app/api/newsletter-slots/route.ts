import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { ensureSlots, listBoard } from "@/lib/services/newsletter-drafter/slots";

/**
 * The Newsletters board: upcoming scheduled slots (2 weeks ahead) + recent
 * drafts. Tops up any missing slots first (DB only — the daily sweep does the
 * Asana sponsor checks), so the board is right even before the cron runs.
 */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) return NextResponse.json({ error: "brand is required" }, { status: 400 });
  await ensureSlots();
  return NextResponse.json(await listBoard(brand));
}
