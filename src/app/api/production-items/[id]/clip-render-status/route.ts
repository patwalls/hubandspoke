import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { clipEdits } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getLatestClipRenderForItem } from "@/lib/services/clip-editor/render-status";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Latest in-app clip render for a production item — feeds the content-detail
 * status chip. NOT flag-gated on purpose: once a clip has been exported, the
 * whole team should see that its video is rendering / ready / failed. Only
 * the actions (`canEdit`: re-open the editor, retry) are limited to users
 * with the `clipEditor` flag. Items never touched by the editor return
 * `{ render: null }` and the chip renders nothing.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const render = await getLatestClipRenderForItem(id);
  if (!render) return NextResponse.json({ render: null });

  const [edit] = await db
    .select({ clipIdeaId: clipEdits.clipIdeaId })
    .from(clipEdits)
    .where(eq(clipEdits.id, render.clipEditId))
    .limit(1);

  return NextResponse.json({
    render,
    clipIdeaId: edit?.clipIdeaId ?? null,
    canEdit: isFeatureEnabled("clipEditor", guard.session.user),
  });
}
