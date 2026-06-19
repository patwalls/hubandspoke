import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  createClipIdeaInDescriptPreciseCut,
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
  const applyLayoutPack = request.nextUrl.searchParams.get("ai") === "1";

  try {
    const result = await createClipIdeaInDescriptPreciseCut({
      clipIdeaId: id,
      actorUserId,
      applyLayoutPack,
    });
    return NextResponse.json({
      ok: true,
      newProductionItemId: result.newProductionItemId,
      sourceBrand: result.sourceBrand,
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
