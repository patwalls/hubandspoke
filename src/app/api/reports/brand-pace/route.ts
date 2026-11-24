import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getBrandPace } from "@/lib/brand-pace/query";

// "Brands this week" on /all — every enabled brand's posts this week against
// its goal (or the same point of last week). src/lib/brand-pace/.
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  try {
    return NextResponse.json({ brands: await getBrandPace() });
  } catch (error) {
    console.error("Error building brand pace:", error);
    return NextResponse.json({ error: "Failed to load brand pace" }, { status: 500 });
  }
}
