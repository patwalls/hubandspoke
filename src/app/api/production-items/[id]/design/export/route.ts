import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { DesignNotFoundError, exportDesign } from "@/lib/services/design-editor/export";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  try {
    return NextResponse.json({ ok: true, ...(await exportDesign({ productionItemId: id, actorUserId: guard.session.user.id as string })) });
  } catch (err) {
    if (err instanceof DesignNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
