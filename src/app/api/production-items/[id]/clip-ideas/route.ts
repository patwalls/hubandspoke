import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  // Return only the most recent batch. Older batches remain in the table for
  // history / comparison but the panel shows just the latest run.
  const [latest] = await db
    .select({ batchId: clipIdeas.batchId, createdAt: clipIdeas.createdAt })
    .from(clipIdeas)
    .where(eq(clipIdeas.sourceProductionItemId, id))
    .orderBy(desc(clipIdeas.createdAt))
    .limit(1);

  if (!latest) {
    return NextResponse.json({ batch: null, ideas: [] });
  }

  const ideas = await db
    .select()
    .from(clipIdeas)
    .where(eq(clipIdeas.batchId, latest.batchId))
    .orderBy(desc(clipIdeas.confidence));

  return NextResponse.json({
    batch: {
      id: latest.batchId,
      createdAt: latest.createdAt,
    },
    ideas: ideas.map((i) => ({
      ...i,
      startSec: Number(i.startSec),
      endSec: Number(i.endSec),
      confidence: i.confidence != null ? Number(i.confidence) : null,
    })),
  });
}
