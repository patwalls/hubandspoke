import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/production-items/[id]/drafts
// Returns every draft for the item, newest-first. The partial unique index on
// (production_item_id) WHERE is_current guarantees at most one row has
// isCurrent=true — the UI consumes that as the editable draft; the rest are
// historical snapshots (Stage 3 adds the history viewer).
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  const drafts = await db
    .select()
    .from(contentDrafts)
    .where(eq(contentDrafts.productionItemId, id))
    .orderBy(desc(contentDrafts.version));

  const current = drafts.find((d) => d.isCurrent) ?? null;

  return NextResponse.json({
    current,
    history: drafts.filter((d) => !d.isCurrent),
  });
}
