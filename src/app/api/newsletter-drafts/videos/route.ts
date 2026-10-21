import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { listFormatVideos } from "@/lib/services/newsletter-drafter/queries";

/** Recent videos a single-video newsletter format (the How-To) can be drafted from. */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const formatId = request.nextUrl.searchParams.get("formatId");
  if (!formatId) return NextResponse.json({ error: "formatId is required" }, { status: 400 });
  const videos = await listFormatVideos(formatId);
  if (!videos) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  return NextResponse.json({ videos });
}
