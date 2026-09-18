import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getLatestDesignRenderForItem } from "@/lib/services/design-editor/render-status";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Latest design render for an item — the content-detail chip. Not
 *  flag-gated (the team should see "rendering / ready"); actions are. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const render = await getLatestDesignRenderForItem(id);
  if (!render) return NextResponse.json({ render: null });
  return NextResponse.json({ render, canEdit: isFeatureEnabled("designEditor", guard.session.user) });
}
