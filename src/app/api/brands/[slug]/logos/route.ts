import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { BrandLogoUploadError, listBrandLogos, uploadBrandLogo } from "@/lib/services/brand-logos";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

/** GET — the brand's logo library (built-in wordmarks, account avatars,
 *  uploads), each with a preview URL. See services/brand-logos.ts. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { slug } = await context.params;
  if (!(await fetchBrandBySlug(slug))) return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  return NextResponse.json({ logos: await listBrandLogos(slug) });
}

/** POST multipart `file` — add a logo to the brand's library. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { slug } = await context.params;
  if (!(await fetchBrandBySlug(slug))) return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  try {
    const logo = await uploadBrandLogo({ brand: slug, file, userId: guard.session.user.id ?? null });
    return NextResponse.json({ logo });
  } catch (err) {
    if (err instanceof BrandLogoUploadError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
