import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { DesignItemCreateError, findOrCreateDesignItem } from "@/lib/services/design-editor/create-item";

/** Body: `{ pillarId, targetFormatId }` → the production item to design on
 *  (created on first open, reused after). */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const body = (await request.json().catch(() => null)) as { pillarId?: unknown; targetFormatId?: unknown } | null;
  if (!body || typeof body.pillarId !== "string" || typeof body.targetFormatId !== "string") {
    return NextResponse.json({ error: "pillarId and targetFormatId are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await findOrCreateDesignItem({ pillarId: body.pillarId, targetFormatId: body.targetFormatId, actorUserId: guard.session.user.id as string }));
  } catch (err) {
    if (err instanceof DesignItemCreateError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
