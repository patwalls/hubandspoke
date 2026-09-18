import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { DesignUnsupportedError, regenerateDesign } from "@/lib/services/design-editor/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Re-draft with the AI. Body: `{ instruction?: string }`. Replaces the
 *  document (new revision) — the editor reloads from the response. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { instruction?: unknown };
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 1000) || null : null;
  try {
    return NextResponse.json(await regenerateDesign({ productionItemId: id, instruction, userId: guard.session.user.id as string }));
  } catch (err) {
    if (err instanceof DesignUnsupportedError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
