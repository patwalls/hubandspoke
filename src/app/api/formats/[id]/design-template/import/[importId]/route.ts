import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { designTemplateImports } from "@/lib/db/schema";
import { parseDesignDoc } from "@/lib/design-editor/doc";
import { resolveImageUrls } from "@/lib/services/design-editor/session";

interface RouteContext {
  params: Promise<{ id: string; importId: string }>;
}

/** A pending row older than this is reported failed (the job died twice). */
const STALE_MS = 10 * 60 * 1000;

/** Poll an import: `{ status: "pending" }`, `{ status: "failed", error }`,
 *  or `{ status: "done", doc, notes, imageUrls }`. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id, importId } = await context.params;
  const [row] = await db
    .select()
    .from(designTemplateImports)
    .where(and(eq(designTemplateImports.id, importId), eq(designTemplateImports.formatId, id)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status === "pending") {
    if (Date.now() - row.createdAt.getTime() > STALE_MS) return NextResponse.json({ status: "failed", error: "The import timed out — try again" });
    return NextResponse.json({ status: "pending" });
  }
  if (row.status === "failed") return NextResponse.json({ status: "failed", error: row.error ?? "Import failed" });
  const parsed = parseDesignDoc(row.doc);
  if (!parsed.ok) return NextResponse.json({ status: "failed", error: parsed.error });
  return NextResponse.json({ status: "done", doc: parsed.doc, notes: row.notes, fileName: row.fileName, imageUrls: await resolveImageUrls(parsed.doc) });
}
