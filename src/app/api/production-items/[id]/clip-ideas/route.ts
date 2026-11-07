import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  formats,
  productionItems,
  transcripts,
  users,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { algorithmLabel } from "@/lib/clip-idea-agent";
import { latestClipIdeaBatches } from "@/lib/services/pillar-clip-ideas";
import { loadFormatOdds } from "@/lib/services/clip-odds";
import { compareIdeasByOdds, oddsKey, type FormatOdds } from "@/lib/clip-odds";

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

  // The newest batch of each format (generation runs one batch per format).
  // Older batches stay in the table for history but aren't listed.
  const latest = await latestClipIdeaBatches(id);

  if (latest.batchIds.length === 0) {
    return NextResponse.json({ batch: null, ideas: [] });
  }

  const rows = await db
    .select({
      id: clipIdeas.id,
      batchId: clipIdeas.batchId,
      targetFormat: clipIdeas.targetFormat,
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
    .where(inArray(clipIdeas.batchId, latest.batchIds));

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

  // Order: formats that beat this account's usual most often first, then
  // video order (lib/clip-odds.ts). Not the writer's estimated_views — it ran
  // ~10× high and carried no signal within a video. Fail-soft: no odds →
  // plain video order.
  const odds = await loadFormatOdds(brand).catch(() => new Map<string, FormatOdds>());
  const ranked = rows
    .map((r) => ({
      ...r,
      startSec: Number(r.startSec),
      odds: r.targetFormat ? (odds.get(oddsKey(brand, r.targetFormat)) ?? null) : null,
    }))
    .sort(compareIdeasByOdds);
  const [formatRow] = await db
    .select({
      id: formats.id,
      name: formats.name,
      brand: formats.brand,
      skill: formats.instructions,
    })
    .from(formats)
    .where(
      and(eq(formats.brand, brand), eq(formats.isClippableFormat, true)),
    )
    .limit(1);
  // The shape exposes `pack` for back-compat with the existing
  // ClipTriageDialog gating: any non-null `pack` means "this format has a
  // prompt configured." Since packs were folded into the Skill on
  // 2026-05-11, we synthesize a sentinel from the skill text — the UI
  // only checks pack != null, never reads its fields.
  const promotionFormat = formatRow
    ? {
        id: formatRow.id,
        name: formatRow.name,
        brand: formatRow.brand,
        pack:
          formatRow.skill && formatRow.skill.trim()
            ? { id: formatRow.id, name: "Skill" }
            : null,
      }
    : null;

  return NextResponse.json({
    batch: {
      id: latest.batchIds.join(","),
      createdAt: latest.createdAt,
    },
    promotionFormat,
    ideas: ranked.map((i) => {
      const startSec = i.startSec;
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
