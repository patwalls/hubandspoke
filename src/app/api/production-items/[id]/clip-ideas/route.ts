import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, users } from "@/lib/db/schema";
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

  const rows = await db
    .select({
      id: clipIdeas.id,
      batchId: clipIdeas.batchId,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      hook: clipIdeas.hook,
      angle: clipIdeas.angle,
      rationale: clipIdeas.rationale,
      confidence: clipIdeas.confidence,
      estimatedViews: clipIdeas.estimatedViews,
      status: clipIdeas.status,
      killReason: clipIdeas.killReason,
      acceptedNotionPageId: clipIdeas.acceptedNotionPageId,
      acceptedNotionPageUrl: clipIdeas.acceptedNotionPageUrl,
      acceptedTargetFormat: clipIdeas.acceptedTargetFormat,
      acceptedEditorUserId: clipIdeas.acceptedEditorUserId,
      acceptedProductionItemId: clipIdeas.acceptedProductionItemId,
      decidedAt: clipIdeas.decidedAt,
      createdAt: clipIdeas.createdAt,
      editorName: users.name,
      editorEmail: users.email,
      editorAvatarUrl: users.avatarUrl,
    })
    .from(clipIdeas)
    .leftJoin(users, eq(users.id, clipIdeas.acceptedEditorUserId))
    .where(eq(clipIdeas.batchId, latest.batchId))
    .orderBy(
      // Sort by estimatedViews desc; older rows without it fall back to
      // confidence so pre-v2 batches still render in a sensible order.
      sql`COALESCE(${clipIdeas.estimatedViews}, 0) DESC, ${clipIdeas.confidence} DESC NULLS LAST`,
    );

  return NextResponse.json({
    batch: {
      id: latest.batchId,
      createdAt: latest.createdAt,
    },
    ideas: rows.map((i) => ({
      ...i,
      startSec: Number(i.startSec),
      endSec: Number(i.endSec),
      confidence: i.confidence != null ? Number(i.confidence) : null,
      estimatedViews: i.estimatedViews ?? null,
      acceptedEditorName: i.editorName ?? i.editorEmail ?? null,
      acceptedEditorEmail: i.editorEmail ?? null,
    })),
  });
}
