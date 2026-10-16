import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { formatsForClipPosts } from "@/lib/services/clip-editor/from-candidate";

/** `?brand=` → the format names whose Repurposed-queue candidates open in
 *  the clip editor, post first (video posts on X). */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand") ?? "starter-story";
  return NextResponse.json({ brand, formats: await formatsForClipPosts(brand) });
}
