import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit } from "@/lib/auth-guards";
import { brandSlugById } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { brandWatermarks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { deleteObject } from "@/lib/s3";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [wm] = await db
    .select()
    .from(brandWatermarks)
    .where(eq(brandWatermarks.id, id))
    .limit(1);

  if (!wm) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const guard = await requireBrandEdit(await brandSlugById(wm.brandId));
  if (guard.response) return guard.response;

  // Remove from S3 then from the DB.
  try {
    await deleteObject(wm.s3Key);
  } catch {
    // S3 delete failure is non-fatal — remove the DB row regardless so
    // the UI stays consistent. Orphaned objects in S3 are cheap.
  }

  await db.delete(brandWatermarks).where(eq(brandWatermarks.id, id));

  return NextResponse.json({ ok: true });
}
