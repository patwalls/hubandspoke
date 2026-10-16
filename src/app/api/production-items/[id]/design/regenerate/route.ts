import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { DesignUnsupportedError, requestDesignRegenerate } from "@/lib/services/design-editor/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Re-draft with the AI. Body: `{ instruction?: string }`. The draft runs on
 *  the worker (it may web-search the founder, past the 30s router limit):
 *  answers 202 `{ drafting: true }` and the editor polls `GET …/design`
 *  until the replaced document (new revision) is there. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { instruction?: unknown };
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 1000) || null : null;
  try {
    return NextResponse.json(await requestDesignRegenerate({ productionItemId: id, instruction, userId: guard.session.user.id as string }), { status: 202 });
  } catch (err) {
    if (err instanceof DesignUnsupportedError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
