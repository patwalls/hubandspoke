import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  createClipIdeaInDescriptFullVideo,
  ClipIdeaAlreadyDecidedError,
  ClipIdeaNotFoundError,
  ClipIdeaSourceMissingMediaError,
  FormatMissingSkillError,
  NoClippableFormatForBrandError,
} from "@/lib/services/promote-clip-idea";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id as string;
  // `?range=1` trims the duplicated composition to the clip idea's
  // timestamps; without it the editor gets the whole pillar. Mirrors the
  // `?ai=1` / `?buffered=1` convention on the precise-cut route.
  const trimToClipRange = request.nextUrl.searchParams.get("range") === "1";

  try {
    const result = await createClipIdeaInDescriptFullVideo({
      clipIdeaId: id,
      actorUserId,
      trimToClipRange,
    });
    return NextResponse.json({
      ok: true,
      newProductionItemId: result.newProductionItemId,
      sourceBrand: result.sourceBrand,
      descriptProjectUrl: result.descriptProjectUrl,
      descriptJobId: result.descriptJobId,
      mode: result.mode,
      rangeApplied: result.rangeApplied,
    });
  } catch (err) {
    if (err instanceof ClipIdeaNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ClipIdeaAlreadyDecidedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ClipIdeaSourceMissingMediaError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof FormatMissingSkillError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof NoClippableFormatForBrandError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
