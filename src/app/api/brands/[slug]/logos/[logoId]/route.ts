import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { deleteBrandLogo } from "@/lib/services/brand-logos";

interface RouteContext {
  params: Promise<{ slug: string; logoId: string }>;
}

/** DELETE — take an uploaded logo out of the brand's library (the file
 *  stays so documents that placed it keep rendering). */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { slug, logoId } = await context.params;
  const ok = await deleteBrandLogo({ brand: slug, id: logoId });
  if (!ok) return NextResponse.json({ error: "Logo not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
