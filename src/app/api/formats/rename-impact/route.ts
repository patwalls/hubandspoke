import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { countFormatRenameImpact } from "@/lib/services/format-rename";

/**
 * Blast radius for renaming a format. The clip-format name is the string key
 * that production_items + clip_ideas link to, so the format-detail UI calls
 * this before committing a rename to show "this will update N items / M clip
 * ideas." Counts reference the format's CURRENT (pre-rename) name.
 *
 * GET /api/formats/rename-impact?id=<formatId>
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const [format] = await db
    .select({ name: formats.name, brand: formats.brand })
    .from(formats)
    .where(eq(formats.id, id));
  if (!format) {
    return NextResponse.json({ error: "Format not found" }, { status: 404 });
  }

  const impact = await countFormatRenameImpact({
    brand: format.brand,
    name: format.name,
  });

  return NextResponse.json({
    name: format.name,
    brand: format.brand,
    ...impact,
  });
}
