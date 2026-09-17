import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas } from "@/lib/db/schema";

/**
 * Clip ideas with an in-progress edit — feeds the "Draft" badge on queue rows.
 *
 * A draft = an edit doc that has been SAVED at least once (`revision > 1`;
 * merely opening an idea creates revision 1 with the untouched default doc)
 * on an idea that hasn't been exported yet (`status = 'suggested'`).
 */
export async function GET() {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;

  const rows = await db
    .select({ clipIdeaId: clipEdits.clipIdeaId, updatedAt: clipEdits.updatedAt })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .where(and(gt(clipEdits.revision, 1), eq(clipIdeas.status, "suggested")));

  return NextResponse.json(
    { drafts: rows.map((r) => ({ clipIdeaId: r.clipIdeaId, updatedAt: r.updatedAt.toISOString() })) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
