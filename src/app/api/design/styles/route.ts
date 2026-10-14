import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { ensureCoverStyle, listCoverStyles } from "@/lib/services/design-editor/cover-styles";
import { DesignUnsupportedError } from "@/lib/services/design-editor/session";

/**
 * GET ?brand=&format= → the cover-style gallery: every published Instagram
 * slideshow cover of the brand, this format first, best first, with each
 * one's extraction state. Cheap (presigns only).
 */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand") ?? "starter-story";
  const format = request.nextUrl.searchParams.get("format");
  return NextResponse.json(await listCoverStyles({ brand, format: format || null }));
}

/**
 * POST { productionItemId } → the style row for that published post,
 * created and queued for extraction (`design-style-extract`) when new or
 * failed. 202 while pending — poll GET /api/design/styles/[styleId].
 */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const body = (await request.json().catch(() => ({}))) as { productionItemId?: unknown };
  if (typeof body.productionItemId !== "string") return NextResponse.json({ error: "productionItemId required" }, { status: 400 });
  try {
    const state = await ensureCoverStyle(body.productionItemId);
    return NextResponse.json(state, { status: state.status === "pending" ? 202 : 200 });
  } catch (err) {
    if (err instanceof DesignUnsupportedError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
