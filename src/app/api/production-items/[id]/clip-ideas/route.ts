import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  descriptPacks,
  formats,
  productionItems,
  transcripts,
  users,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { algorithmLabel } from "@/lib/clip-idea-agent";
import { getPromotedClipFormat } from "@/lib/services/promote-clip-idea";

const TRANSCRIPT_EXCERPT_MAX = 220;

function buildExcerpt(
  segments: Array<{ startSec: number; endSec: number; text: string }>,
  startSec: number,
  endSec: number,
): string | null {
  const overlapping = segments.filter(
    (s) => s.endSec > startSec && s.startSec < endSec,
  );
  if (overlapping.length === 0) return null;
  const joined = overlapping
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  if (joined.length <= TRANSCRIPT_EXCERPT_MAX) return joined;
  return joined.slice(0, TRANSCRIPT_EXCERPT_MAX).trimEnd() + "…";
}

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
      blueprintAnchorHook: clipIdeas.blueprintAnchorHook,
      transcriptAnchorQuote: clipIdeas.transcriptAnchorQuote,
      transcriptAnchorStartSec: clipIdeas.transcriptAnchorStartSec,
      promptVersion: clipIdeas.promptVersion,
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

  // One transcript per source item — fetch it once and slice per-idea for
  // the list card preview. Null if the source hasn't been transcribed.
  const [transcript] = await db
    .select({ segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, id))
    .limit(1);
  const segments = transcript?.segments ?? [];

  // Look up the canonical promotion format (PROMOTED_CLIP_FORMAT) for the
  // source's brand and its attached Descript pack. The clip-triage dialog
  // uses this to gate the four "Create in Descript" buttons (and to show
  // a header pointing the user at the format edit page when no pack is
  // attached).
  const [source] = await db
    .select({ brand: productionItems.brand })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  const brand = source?.brand ?? "starter-story";
  const promotionFormatName = getPromotedClipFormat(brand);
  const [formatRow] = await db
    .select({
      id: formats.id,
      name: formats.name,
      brand: formats.brand,
      packId: descriptPacks.id,
      packName: descriptPacks.name,
    })
    .from(formats)
    .leftJoin(descriptPacks, eq(formats.descriptPackId, descriptPacks.id))
    .where(
      and(eq(formats.name, promotionFormatName), eq(formats.brand, brand)),
    )
    .limit(1);
  const promotionFormat = formatRow
    ? {
        id: formatRow.id,
        name: formatRow.name,
        brand: formatRow.brand,
        pack: formatRow.packId
          ? { id: formatRow.packId, name: formatRow.packName ?? "" }
          : null,
      }
    : null;

  return NextResponse.json({
    batch: {
      id: latest.batchId,
      createdAt: latest.createdAt,
    },
    promotionFormat,
    ideas: rows.map((i) => {
      const startSec = Number(i.startSec);
      const endSec = Number(i.endSec);
      return {
        ...i,
        startSec,
        endSec,
        confidence: i.confidence != null ? Number(i.confidence) : null,
        estimatedViews: i.estimatedViews ?? null,
        transcriptAnchorStartSec:
          i.transcriptAnchorStartSec != null
            ? Number(i.transcriptAnchorStartSec)
            : null,
        acceptedEditorName: i.editorName ?? i.editorEmail ?? null,
        acceptedEditorEmail: i.editorEmail ?? null,
        transcriptExcerpt: buildExcerpt(segments, startSec, endSec),
        algorithmLabel: algorithmLabel(i.promptVersion),
      };
    }),
  });
}
