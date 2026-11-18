import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { getUsualCrossPostEditors } from "@/lib/db/cross-post-usual-editors";

/**
 * GET /api/cross-post-queue/usual-editors?brand=<slug>
 *
 * `{ editors: { "<accountId>:<postType>": { userId, name } } }` — the cross-post
 * targets on the brand whose cross-posts always get handed to one editor
 * (src/lib/cross-post-usual.ts → usualEditorOf). The cross-post picker assigns
 * those targets to that editor instead of its "Assign to" pick, and says so on
 * the row. Flag `crossPostUsualEditor`.
 */
export async function GET(request: NextRequest) {
  const flag = await requireFeature("crossPostUsualEditor");
  if (flag.response) return flag.response;
  const brand = request.nextUrl.searchParams.get("brand");
  const guard = await requireBrandEdit(brand);
  if (guard.response) return guard.response;
  const editors = await getUsualCrossPostEditors(brand!);
  return NextResponse.json({ editors });
}
