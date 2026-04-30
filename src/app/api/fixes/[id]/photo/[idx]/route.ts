import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { fixes } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";

// Returns a 5-minute presigned GET url for one photo on a fix. Bucket stays
// private — the /fixes admin page calls this per attached photo on render.
// 302-redirects so an <img src=...> tag works directly.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; idx: string }> }
) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;

  const { id, idx } = await params;
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0) {
    return NextResponse.json({ error: "Bad idx" }, { status: 400 });
  }

  const [row] = await db
    .select({ photoKeys: fixes.photoKeys })
    .from(fixes)
    .where(eq(fixes.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Fix not found" }, { status: 404 });
  }

  const key = row.photoKeys?.[i];
  if (!key) {
    return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  }

  const url = await getPresignedGetUrl(key, 300);
  return NextResponse.redirect(url, 302);
}
