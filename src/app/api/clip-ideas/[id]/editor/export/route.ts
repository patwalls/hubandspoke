import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import {
  ClipEditEmptyError,
  ClipEditNotFoundError,
  exportClipEdit,
} from "@/lib/services/clip-editor/export";
import {
  ClipIdeaAlreadyDecidedError,
  ClipIdeaNotFoundError,
  ClipIdeaProductionItemMissingError,
  ClipIdeaSourceMissingMediaError,
} from "@/lib/services/promote-clip-idea";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Export the saved edit: promote the idea and queue a `clip-render` job.
 *  Returns immediately — the render runs on the worker dyno. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;

  try {
    const result = await exportClipEdit({
      clipIdeaId: id,
      actorUserId: guard.session.user.id as string,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ClipIdeaNotFoundError || err instanceof ClipEditNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ClipIdeaAlreadyDecidedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof ClipEditEmptyError ||
      err instanceof ClipIdeaSourceMissingMediaError ||
      err instanceof ClipIdeaProductionItemMissingError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
