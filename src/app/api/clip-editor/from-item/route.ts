import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { attachClipPostToItem, ClipPostCreateError } from "@/lib/services/clip-editor/from-candidate";

/** Body: `{ productionItemId }` — an existing Idea row from the All /
 *  Triggered tabs → the clip idea the editor opens on (the intro picked and
 *  linked on first open, reused after). A 422 carries a `reason` the queue
 *  uses to fall back to the classic dialog. */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const body = (await request.json().catch(() => null)) as { productionItemId?: unknown } | null;
  if (!body || typeof body.productionItemId !== "string") {
    return NextResponse.json({ error: "productionItemId is required" }, { status: 400 });
  }
  const brand = await brandOfProductionItem(body.productionItemId);
  const brandGuard = await requireBrandEdit(brand);
  if (brandGuard.response) return brandGuard.response;
  try {
    const made = await attachClipPostToItem({ productionItemId: body.productionItemId, actorUserId: guard.session.user.id as string });
    // The row now carries a clip idea — the queue report shows it as a draft.
    if (made.created) invalidateReportCaches({ brands: [brand] });
    return NextResponse.json(made);
  } catch (err) {
    if (err instanceof ClipPostCreateError) return NextResponse.json({ error: err.message, reason: err.reason }, { status: err.status });
    throw err;
  }
}
