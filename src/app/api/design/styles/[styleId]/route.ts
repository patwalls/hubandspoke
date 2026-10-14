import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { getCoverStyle } from "@/lib/services/design-editor/cover-styles";

interface RouteContext {
  params: Promise<{ styleId: string }>;
}

/** Poll a cover style's extraction: 202 while pending, 200 done, 422 failed (with the reason). */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { styleId } = await context.params;
  const state = await getCoverStyle(styleId);
  if (!state) return NextResponse.json({ error: "Style not found" }, { status: 404 });
  if (state.status === "failed") return NextResponse.json({ ...state, error: `Couldn't read that cover: ${state.error ?? "unknown error"}` }, { status: 422 });
  return NextResponse.json(state, { status: state.status === "pending" ? 202 : 200 });
}
