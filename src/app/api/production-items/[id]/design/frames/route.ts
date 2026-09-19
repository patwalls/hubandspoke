import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { listFrames, requestAutoFrames, requestFrameAt } from "@/lib/services/design-editor/frames";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function sourceIdFor(id: string): Promise<string | null> {
  const [row] = await db.select({ pillar: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, id)).limit(1);
  return row ? (row.pillar ?? id) : null;
}

/** The source video's photo library so far (the editor polls this while
 *  frames are pending). `id` is the design item; frames belong to its source. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  return NextResponse.json(await listFrames(sourceId));
}

/** Grab a frame at an exact time — `{ atSec: number }` — or (re)request the
 *  automatic filmstrip (`{ force: true }` re-runs it after a failure). */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { atSec?: unknown; force?: unknown };
  if (typeof body.atSec === "number" && Number.isFinite(body.atSec) && body.atSec >= 0) {
    return NextResponse.json({ frame: await requestFrameAt(sourceId, body.atSec) });
  }
  await requestAutoFrames(sourceId, { force: body.force === true });
  return NextResponse.json(await listFrames(sourceId));
}
