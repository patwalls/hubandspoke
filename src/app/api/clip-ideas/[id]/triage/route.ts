import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import {
  killClipIdea,
  promoteClipIdea,
  PromoteClipIdeaError,
} from "@/lib/services/promote-clip-idea";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Notion create + DB update; generally <10s.
export const maxDuration = 60;

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  const action = body?.action as string | undefined;

  if (action === "accept") {
    const targetFormatName = body?.targetFormatName as string | undefined;
    const editorUserId = body?.editorUserId as string | undefined;
    if (!targetFormatName || !editorUserId) {
      return NextResponse.json(
        { error: "targetFormatName and editorUserId are required for accept" },
        { status: 400 }
      );
    }
    try {
      const result = await promoteClipIdea({
        clipIdeaId: id,
        targetFormatName,
        editorUserId,
        decidedByUserId: guard.session.user.id as string,
      });
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      const kind =
        err instanceof PromoteClipIdeaError ? err.kind : "unknown";
      const status =
        kind === "idea_not_found" || kind === "pillar_not_found"
          ? 404
          : kind === "editor_no_notion_id" ||
              kind === "idea_not_suggested" ||
              kind === "format_not_found" ||
              kind === "editor_not_found"
            ? 400
            : 502;
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message, kind }, { status });
    }
  }

  if (action === "kill") {
    const killReason = typeof body?.killReason === "string" ? body.killReason : null;
    await killClipIdea({
      clipIdeaId: id,
      killReason: killReason?.trim() || null,
      decidedByUserId: guard.session.user.id as string,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "action must be 'accept' or 'kill'" },
    { status: 400 }
  );
}
