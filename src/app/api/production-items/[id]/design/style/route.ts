import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { applyCoverStyle } from "@/lib/services/design-editor/cover-styles";
import { DesignItemNotFoundError, DesignUnsupportedError } from "@/lib/services/design-editor/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Rebuild this post's cover in a published cover's style (AI fill of the
 * style's template, ~15s): the editor replaces its page 1 with the returned
 * page and, as for the hero cover, makes the cutout in the browser when the
 * style has a cutout slot. Body: `{ styleId, canvas?, currentHeadline?, instruction? }`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { styleId?: unknown; canvas?: { width?: unknown; height?: unknown }; currentHeadline?: unknown; instruction?: unknown };
  if (typeof body.styleId !== "string") return NextResponse.json({ error: "styleId required" }, { status: 400 });
  const canvas = typeof body.canvas?.width === "number" && typeof body.canvas?.height === "number" ? { width: body.canvas.width, height: body.canvas.height } : null;
  try {
    return NextResponse.json(
      await applyCoverStyle({
        productionItemId: id,
        styleId: body.styleId,
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
