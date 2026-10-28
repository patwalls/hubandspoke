import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { createNewPost, listNewPostFormats, listNewPostPillars, NewPostError } from "@/lib/services/new-post";

/** The nav's New menu, for posts (the newsletter has /api/newsletter-drafts).
 *  `GET ?brand=&kind=` → the kind's formats (each with the editor it opens
 *  in) and the brand's pillar videos. */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand");
  const kind = request.nextUrl.searchParams.get("kind");
  if (!brand || !kind) return NextResponse.json({ error: "brand and kind are required" }, { status: 400 });
  const flags = { designEditor: isFeatureEnabled("designEditor", guard.session.user), clipEditor: isFeatureEnabled("clipEditor", guard.session.user) };
  try {
    const [formats, pillars] = await Promise.all([listNewPostFormats(brand, kind, flags), listNewPostPillars(brand)]);
    return NextResponse.json({ formats, pillars });
  } catch (err) {
    if (err instanceof NewPostError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** Body: `{ kind, brand, formatId?, pillarId, angle? }` → `{ editor, productionItemId, clipIdeaId? }`. */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.kind !== "string" || typeof body.brand !== "string" || typeof body.pillarId !== "string") {
    return NextResponse.json({ error: "kind, brand and pillarId are required" }, { status: 400 });
  }
  const brandGuard = await requireBrandEdit(body.brand);
  if (brandGuard.response) return brandGuard.response;
  const flags = { designEditor: isFeatureEnabled("designEditor", guard.session.user), clipEditor: isFeatureEnabled("clipEditor", guard.session.user) };
  try {
    const made = await createNewPost({
      kind: body.kind,
      brand: body.brand,
      formatId: typeof body.formatId === "string" && body.formatId ? body.formatId : null,
      pillarId: body.pillarId,
      angle: typeof body.angle === "string" ? body.angle : null,
      actorUserId: guard.session.user.id as string,
      flags,
    });
    invalidateReportCaches();
    return NextResponse.json(made);
  } catch (err) {
    if (err instanceof NewPostError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
