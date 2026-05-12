import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  createClipIdeaInDescript,
  ClipIdeaAlreadyDecidedError,
  ClipIdeaNotFoundError,
  ClipIdeaSourceMissingDescriptProjectError,
  FormatMissingSkillError,
} from "@/lib/services/promote-clip-idea";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id as string;

  try {
    const result = await createClipIdeaInDescript({
      clipIdeaId: id,
      actorUserId,
    });
    // When the source had no Descript project we transparently fall through
    // to the precise-cut path, which doesn't return descriptProjectUrl /
    // descriptJobId yet (the worker backfills those on completion). Return
    // them only when the agent path actually ran.
    return NextResponse.json({
      ok: true,
      newProductionItemId: result.newProductionItemId,
      sourceBrand: result.sourceBrand,
      descriptProjectUrl:
        "descriptProjectUrl" in result ? result.descriptProjectUrl : null,
      descriptJobId:
        "descriptJobId" in result ? result.descriptJobId : null,
    });
  } catch (err) {
    if (err instanceof ClipIdeaNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ClipIdeaAlreadyDecidedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ClipIdeaSourceMissingDescriptProjectError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof FormatMissingSkillError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
