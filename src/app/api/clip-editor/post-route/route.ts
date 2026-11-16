import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { brandOfFormat } from "@/lib/brand-access";
import { clipPostRoutingFor } from "@/lib/services/clip-editor/from-candidate";

/** `?formatId=` → which editor this format's posts on X open in, and why
 *  (the format page's read-only "Opens in" row). `route: null` when the
 *  format has no X channel — the row is hidden then. */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const formatId = request.nextUrl.searchParams.get("formatId");
  if (!formatId) return NextResponse.json({ error: "formatId is required" }, { status: 400 });
  const brand = await brandOfFormat(formatId);
  if (!brand) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  const route = (await clipPostRoutingFor(brand)).find((r) => r.formatId === formatId) ?? null;
  return NextResponse.json({ route: route && { editor: route.editor, because: route.because } });
}
