import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { brandOfFormat, brandOfProductionItem } from "@/lib/brand-access";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { ClipPostCreateError, findOrCreateClipPost } from "@/lib/services/clip-editor/from-candidate";

/** Body: `{ pillarId, targetFormatId }` → the clip idea (and its item) the
 *  editor opens on — created on first open, reused after. A 422 carries a
 *  `reason` the queue uses to fall back to the classic dialog. */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const body = (await request.json().catch(() => null)) as { pillarId?: unknown; targetFormatId?: unknown } | null;
  if (!body || typeof body.pillarId !== "string" || typeof body.targetFormatId !== "string") {
    return NextResponse.json({ error: "pillarId and targetFormatId are required" }, { status: 400 });
  }
  // The clip idea belongs to the pillar's brand; its post lands in the target format's brand.
  for (const brand of new Set([await brandOfProductionItem(body.pillarId), await brandOfFormat(body.targetFormatId)])) {
    const brandGuard = await requireBrandEdit(brand);
    if (brandGuard.response) return brandGuard.response;
  }
  try {
    const created = await findOrCreateClipPost({ pillarId: body.pillarId, targetFormatId: body.targetFormatId, actorUserId: guard.session.user.id as string });
    // The new item puts its (pillar, format) pair in flight — off the Repurposed queue.
    if (created.created) invalidateReportCaches();
    return NextResponse.json(created);
  } catch (err) {
    if (err instanceof ClipPostCreateError) return NextResponse.json({ error: err.message, reason: err.reason }, { status: err.status });
    throw err;
  }
}
