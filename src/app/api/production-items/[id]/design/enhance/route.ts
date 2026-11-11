import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { brandOfProductionItem } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { imageSourceSchema, type ImageSource } from "@/lib/editor/image-source";
import { isAppBucket } from "@/lib/s3";
import { canEnhance } from "@/lib/design-editor/enhance";
import { enhanceStatus, requestEnhance } from "@/lib/services/design-editor/enhance";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function sourceIdFor(id: string): Promise<string | null> {
  const [row] = await db.select({ pillar: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, id)).limit(1);
  return row ? (row.pillar ?? id) : null;
}

function parseSrc(raw: unknown): ImageSource | null {
  const parsed = imageSourceSchema.safeParse(raw);
  if (!parsed.success || !canEnhance(parsed.data)) return null;
  // Only our own buckets — never presign a bucket the caller names (S-120).
  if (parsed.data.kind === "s3" && parsed.data.bucket && !isAppBucket(parsed.data.bucket)) return null;
  return parsed.data;
}

/** `POST { src, blur }` — Enhance (AI upscale) a picture: `{ state: "done",
 *  photo }` when it's already made, else `{ state: "pending" }` and the
 *  `design-enhance` job runs (~1 min). `id` is the design item; the result
 *  goes to its source video's photo library. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfProductionItem(id));
  if (brandGuard.response) return brandGuard.response;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { src?: unknown; blur?: unknown };
  const src = parseSrc(body.src);
  if (!src) return NextResponse.json({ error: "Only stored or https pictures can be enhanced" }, { status: 422 });
  const status = await requestEnhance({ sourceItemId: sourceId, src, blur: body.blur === true, userId: (guard.session.user.id as string) ?? null });
  return NextResponse.json(status);
}

/** `?src=<json ImageSource>&blur=1` — poll an enhancement. */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const sourceId = await sourceIdFor(id);
  if (!sourceId) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  let raw: unknown = null;
  try {
    raw = JSON.parse(request.nextUrl.searchParams.get("src") ?? "null");
  } catch {
    /* falls through to 422 */
  }
  const src = parseSrc(raw);
  if (!src) return NextResponse.json({ error: "Bad picture" }, { status: 422 });
  return NextResponse.json(await enhanceStatus(sourceId, src, request.nextUrl.searchParams.get("blur") === "1"));
}
