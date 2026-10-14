import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { imageSourceSchema } from "@/lib/editor/image-source";
import { addPhoto, DesignPhotoUploadError } from "@/lib/services/design-editor/photos";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Upload a picture into the SOURCE video's photo library (multipart `file`;
 * `kind` = "upload" (default) or "cutout" with `cutoutOf` = the JSON
 * ImageSource it was cut from). Saved on the pillar, so every post made
 * from the video can use it. Returns the library entry, which is also an
 * ImageCandidate the editor can place or swap in.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [row] = await db.select({ pillar: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  const kind = form?.get("kind") === "cutout" ? "cutout" : "upload";
  let cutoutOf = null;
  if (kind === "cutout") {
    const raw = form?.get("cutoutOf");
    const parsed = typeof raw === "string" ? imageSourceSchema.safeParse(JSON.parse(raw)) : null;
    cutoutOf = parsed?.success ? parsed.data : null;
  }
  try {
    const photo = await addPhoto({ sourceItemId: row.pillar ?? id, file, kind, cutoutOf, userId: guard.session.user.id as string });
    return NextResponse.json({ image: { label: photo.label, src: photo.src, previewUrl: photo.previewUrl }, photo, width: photo.width, height: photo.height });
  } catch (err) {
    if (err instanceof DesignPhotoUploadError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
