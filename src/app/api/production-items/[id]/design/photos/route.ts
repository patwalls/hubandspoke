import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { deletePhoto, listPhotos, requestScreens } from "@/lib/services/design-editor/photos";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function sourceIdFor(id: string): Promise<string | null> {
  const [row] = await db.select({ pillar: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, id)).limit(1);
  return row ? (row.pillar ?? id) : null;
}

/** The source video's extra picture library (uploads, cutouts, screens) —
 *  polled while the screen scan is pending. `id` is the design item. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  return NextResponse.json(await listPhotos(sourceId));
}

/** `{ scan: true, force?: true }` — find the dashboard / revenue screens in
 *  the video (worker job; `force` rescans). */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfProductionItem(id));
  if (brandGuard.response) return brandGuard.response;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { scan?: unknown; force?: unknown };
  if (body.scan === true) await requestScreens(sourceId, { force: body.force === true });
  return NextResponse.json(await listPhotos(sourceId));
}

/** `?photoId=` — remove a picture from the library. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfProductionItem(id));
  if (brandGuard.response) return brandGuard.response;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const photoId = request.nextUrl.searchParams.get("photoId");
  if (!photoId) return NextResponse.json({ error: "photoId is required" }, { status: 400 });
  const ok = await deletePhoto(sourceId, photoId);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
