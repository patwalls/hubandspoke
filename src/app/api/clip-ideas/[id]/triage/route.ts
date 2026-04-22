import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  assignClipIdea,
  ClipIdeaAlreadyDecidedError,
  ClipIdeaNotFoundError,
  killClipIdea,
} from "@/lib/services/promote-clip-idea";
import { enqueueNotification } from "@/lib/services/notifications";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  const action = body?.action as string | undefined;
  const actorUserId = guard.session.user.id as string;

  if (action === "kill") {
    const killReason = typeof body?.killReason === "string" ? body.killReason : null;
    await killClipIdea({
      clipIdeaId: id,
      killReason: killReason?.trim() || null,
      decidedByUserId: actorUserId,
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "assign") {
    const editorUserId =
      typeof body?.editorUserId === "string" ? body.editorUserId : null;
    if (!editorUserId) {
      return NextResponse.json(
        { error: "editorUserId is required" },
        { status: 400 },
      );
    }
    try {
      const result = await assignClipIdea({
        clipIdeaId: id,
        editorUserId,
        decidedByUserId: actorUserId,
      });
      void enqueueNotification({
        userId: editorUserId,
        kind: "assigned",
        contentItemId: result.newProductionItemId,
        actorUserId,
        payload: {
          kind: "assigned",
          role: "editor",
          title: result.hook,
        },
      });
      return NextResponse.json({
        ok: true,
        sourceProductionItemId: result.sourceProductionItemId,
        newProductionItemId: result.newProductionItemId,
        sourceBrand: result.sourceBrand,
        editorName: result.editorName,
        editorEmail: result.editorEmail,
      });
    } catch (err) {
      if (err instanceof ClipIdeaNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof ClipIdeaAlreadyDecidedError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  }

  return NextResponse.json(
    { error: "action must be 'kill' or 'assign'" },
    { status: 400 },
  );
}
