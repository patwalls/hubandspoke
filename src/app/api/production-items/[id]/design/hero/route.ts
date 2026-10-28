import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { buildHeroCoverForItem } from "@/lib/services/design-editor/hero";
import { DesignItemNotFoundError, DesignUnsupportedError } from "@/lib/services/design-editor/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Build a hero cover for this post (AI fill, ~15s): the editor replaces its
 * page 1 with the returned page and, if `cutout` is null, makes the cutout
 * of `pick` in the browser and drops it into the cutout slot.
 * Body: `{ canvas?, currentHeadline?, instruction? }`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfProductionItem(id));
  if (brandGuard.response) return brandGuard.response;
  const body = (await request.json().catch(() => ({}))) as { canvas?: { width?: unknown; height?: unknown }; currentHeadline?: unknown; instruction?: unknown };
  const canvas = typeof body.canvas?.width === "number" && typeof body.canvas?.height === "number" ? { width: body.canvas.width, height: body.canvas.height } : null;
  try {
    return NextResponse.json(
      await buildHeroCoverForItem({
        productionItemId: id,
        canvas,
        currentHeadline: typeof body.currentHeadline === "string" ? body.currentHeadline.slice(0, 300) : null,
        instruction: typeof body.instruction === "string" ? body.instruction.slice(0, 1000) : null,
      }),
    );
  } catch (err) {
    if (err instanceof DesignItemNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof DesignUnsupportedError) return NextResponse.json({ error: err.message, unsupported: err.reason }, { status: 422 });
    throw err;
  }
}
