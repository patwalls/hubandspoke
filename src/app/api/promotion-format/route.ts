import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { descriptPacks, formats } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PROMOTED_CLIP_FORMAT } from "@/lib/services/promote-clip-idea";

/**
 * Returns the canonical clip-promotion format (`PROMOTED_CLIP_FORMAT`) for
 * a brand and its attached Descript pack — same shape the clip-ideas
 * route returns inline as `promotionFormat`. Used by the clip-triage
 * dialog when its parent doesn't already pass the field as a prop (the
 * pillar's clip-ideas tab does; the queue does not, since pre-fetching
 * per-row would be wasteful).
 *
 * Response: `{ promotionFormat: { id, name, brand, pack: {id,name} | null } | null }`.
 * Returns `null` when no format row exists yet for the brand (lazy-create
 * happens on first promotion).
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) {
    return NextResponse.json({ error: "brand is required" }, { status: 400 });
  }

  const [row] = await db
    .select({
      id: formats.id,
      name: formats.name,
      brand: formats.brand,
      packId: descriptPacks.id,
      packName: descriptPacks.name,
    })
    .from(formats)
    .leftJoin(descriptPacks, eq(formats.descriptPackId, descriptPacks.id))
    .where(
      and(eq(formats.name, PROMOTED_CLIP_FORMAT), eq(formats.brand, brand)),
    )
    .limit(1);

  const promotionFormat = row
    ? {
        id: row.id,
        name: row.name,
        brand: row.brand,
        pack: row.packId
          ? { id: row.packId, name: row.packName ?? "" }
          : null,
      }
    : null;

  return NextResponse.json({ promotionFormat });
}
