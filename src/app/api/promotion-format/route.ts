import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

/**
 * Returns the brand's clip-promotion format (the one with
 * `is_clip_descript_format=true`) — same shape the clip-ideas route
 * returns inline as `promotionFormat`. Used by the clip-triage dialog
 * when its parent doesn't already pass the field as a prop.
 *
 * The `pack` field is a synthetic sentinel kept for back-compat:
 * `pack != null` ⇒ "the format has a Skill" (the prompt that gets sent
 * to Descript's Underlord). The Skill itself lives in
 * `formats.instructions`; the Descript packs table was folded into it
 * on 2026-05-11. Callers only check `pack != null` to decide whether to
 * enable the four "Create in Descript" buttons.
 *
 * Response: `{ promotionFormat: { id, name, brand, pack: {id,name} | null } | null }`.
 * Returns `null` when no format on the brand carries the flag — the
 * triage UI surfaces a "configure clip format" hint in that case.
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
      skill: formats.instructions,
    })
    .from(formats)
    .where(
      and(eq(formats.brand, brand), eq(formats.isClipDescriptFormat, true)),
    )
    .limit(1);

  const promotionFormat = row
    ? {
        id: row.id,
        name: row.name,
        brand: row.brand,
        pack:
          row.skill && row.skill.trim()
            ? { id: row.id, name: "Skill" }
            : null,
      }
    : null;

  return NextResponse.json({ promotionFormat });
}
