import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { clipIdeas, formats, productionItems } from "@/lib/db/schema";
import { clipLookSchema } from "@/lib/clip-editor/doc";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * "Save look as the format's template": the style half of the edit
 * (background, video placement, layers) becomes the clip idea's target
 * format's `clip_template`, so every new edit of that format starts from it.
 * Body: `{ look: ClipLook }`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { look?: unknown };
  const parsed = clipLookSchema.safeParse(body.look);
  if (!parsed.success) return NextResponse.json({ error: "Invalid look" }, { status: 400 });
  const [idea] = await db
    .select({ targetFormat: clipIdeas.targetFormat, brand: productionItems.brand })
    .from(clipIdeas)
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(eq(clipIdeas.id, id))
    .limit(1);
  if (!idea) return NextResponse.json({ error: "Clip idea not found" }, { status: 404 });
  if (!idea.targetFormat) return NextResponse.json({ error: "This clip idea has no target format" }, { status: 422 });
  const [format] = await db
    .update(formats)
    .set({ clipTemplate: parsed.data, clipTemplateUpdatedAt: new Date() })
    .where(and(eq(formats.brand, idea.brand ?? "starter-story"), eq(formats.name, idea.targetFormat)))
    .returning({ id: formats.id, name: formats.name });
  if (!format) return NextResponse.json({ error: `Format "${idea.targetFormat}" not found` }, { status: 404 });
  return NextResponse.json({ ok: true, format });
}
