import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { uploadScreenshot } from "@/lib/services/newsletter-drafter/screenshots";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Use an uploaded image for a screenshot placeholder (multipart: markKey + file). */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const markKey = form?.get("markKey");
  const file = form?.get("file");
  if (typeof markKey !== "string" || !markKey || markKey.length > 200 || !(file instanceof File)) {
    return NextResponse.json({ error: "Send markKey and an image file" }, { status: 400 });
  }
  const r = await uploadScreenshot(id, markKey, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return NextResponse.json(r);
}
