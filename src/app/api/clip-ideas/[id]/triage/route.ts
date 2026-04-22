import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { killClipIdea } from "@/lib/services/promote-clip-idea";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  const action = body?.action as string | undefined;

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
    { error: "action must be 'kill'" },
    { status: 400 }
  );
}
