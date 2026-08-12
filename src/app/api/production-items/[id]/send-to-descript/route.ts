import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  reprocessProductionItemInDescript,
  ReprocessMissingClipIdeaError,
  ReprocessMissingMediaError,
  ReprocessMissingDescriptProjectError,
  type ReprocessMode,
} from "@/lib/services/reprocess-in-descript";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_MODES: ReprocessMode[] = ["full", "precise", "buffered", "agent"];

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const actorUserId = guard.session.user.id as string;
  const mode = request.nextUrl.searchParams.get("mode") as ReprocessMode | null;

  if (!mode || !VALID_MODES.includes(mode)) {
    return NextResponse.json(
      { error: `mode must be one of: ${VALID_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    await reprocessProductionItemInDescript({
      productionItemId: id,
      actorUserId,
      mode,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReprocessMissingClipIdeaError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ReprocessMissingMediaError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ReprocessMissingDescriptProjectError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[send-to-descript]", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
