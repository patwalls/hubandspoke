import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireSession } from "@/lib/auth-guards";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { latestAutoClose, undoAutoClose } from "@/lib/services/idea-auto-close";

export const dynamic = "force-dynamic";

/**
 * The weekly clip-idea auto-close (services/idea-auto-close.ts), as the
 * queue's History tab shows it.
 *   GET  ?brand=…            → { latest: { run, closed, undoable } | null }
 *   POST { brand, run }      → { restored } — puts that run's still-Killed
 *                              items back to Idea.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand || brand === "all") return NextResponse.json({ latest: null });
  return NextResponse.json({ latest: await latestAutoClose(brand) });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { brand?: unknown; run?: unknown } | null;
  const brand = typeof body?.brand === "string" ? body.brand.trim() : "";
  const run = typeof body?.run === "string" ? body.run.trim() : "";
  if (!brand || brand === "all" || !/^\d{4}-\d{2}-\d{2}$/.test(run)) {
    return NextResponse.json({ error: "brand and run (YYYY-MM-DD) are required" }, { status: 400 });
  }
  const guard = await requireBrandEdit(brand);
  if (guard.response) return guard.response;
  const restored = await undoAutoClose({ brand, run, actorUserId: guard.session.user.id ?? null });
  if (restored > 0) invalidateReportCaches({ brands: [brand] });
  return NextResponse.json({ restored });
}
