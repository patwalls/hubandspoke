import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { prepareCrossPostSource } from "@/lib/services/cross-post-source";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/cross-post-prepare
 *
 * Warm-up for the cross-post dialog: called (fire-and-forget) the first time
 * someone ticks a target, so the source's enrichment / media archive runs
 * while they finish choosing instead of inside the "Cross-post N" click.
 * The cross-post POSTs join this same run (src/lib/cross-post-source-preparer.ts).
 * No-op when the source is already ready. Same guard as the cross-post POST.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const guard = await requireBrandEdit(await brandOfProductionItem(id));
  if (guard.response) return guard.response;
  const result = await prepareCrossPostSource(id);
  return NextResponse.json({ ok: true, enriched: result.enriched });
}
