import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { ensureSlots, listBoard, refreshSlotSponsors } from "@/lib/services/newsletter-drafter/slots";

/** "Refresh" on the board: top up slots and re-check every idea slot's Asana sponsor now (read-only on Asana). */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) return NextResponse.json({ error: "brand is required" }, { status: 400 });
  const brandGuard = await requireBrandEdit(brand);
  if (brandGuard.response) return brandGuard.response;
  await ensureSlots();
  await refreshSlotSponsors();
  return NextResponse.json(await listBoard(brand));
}
