import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  generateClipIdeas,
  GENERATED_BY,
  PROMPT_VERSION,
  type PerfRow,
} from "@/lib/clip-idea-agent";
import { topShortFormPerformers } from "@/lib/db/queries";
import { findAccountForBrandPlatform } from "@/lib/db/accounts";
import { resolveAssignees } from "@/lib/services/assignees";

const SHORT_FORM_PLATFORMS = ["YouTube Shorts", "Instagram Reel", "TikTok"];
const PROMOTED_CLIP_FORMAT = "Repackage section with hook";
const AUTO_GENERATE_POST_TYPES = new Set(["youtube_long"]);

function isShortForm(platform: string[] | null): boolean {
  if (!platform) return false;
  return platform.some((p) => SHORT_FORM_PLATFORMS.includes(p));
}

function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function buildContentBody(args: {
  sourceTitle: string | null;
  startSec: number;
  endSec: number;
  angle: string;
  rationale: string;
}): string {
  const duration = Math.max(0, Math.round(args.endSec - args.startSec));
  const timestampRange = `${formatTimestamp(args.startSec)}–${formatTimestamp(args.endSec)} (${duration}s)`;
  return [
    `Source: ${args.sourceTitle ?? "(untitled)"}`,
    `Timestamp: ${timestampRange}`,
    "",
    `Angle: ${args.angle}`,
    "",
    `Why: ${args.rationale}`,
  ].join("\n");
}

export type ClipIdeaGenerateOutcome =
  | { status: "ok"; ideasCreated: number; batchId: string }
  | { status: "skip"; reason: string };

export interface ClipIdeaGenerateOptions {
  /** Caller for the resulting prod_items rows (producer + editor). When
   *  omitted (cron / backfill path) we resolve via `resolveAssignees`. */
  actorUserId?: string;
  /** Skip the post_type gate. Set true only for the manual route, where the
   *  operator has already chosen a pillar; the cron path keeps the gate on
   *  to avoid LLM-bombing every transcribed reel. */
  skipPostTypeGate?: boolean;
}

/**
 * Generate clip ideas for a pillar (long-form YouTube by default), insert the
 * `clip_ideas` rows, create a paired `production_items` row per idea so they
 * land in the brand's triage queue, and link the two via
 * `clip_ideas.accepted_production_item_id`.
 *
 * Idempotent: skips if any clip_ideas row already exists for the pillar.
 * Used by the manual `/api/production-items/[id]/clip-ideas/generate` route
 * (with `actorUserId`) and the auto-fire path that runs after a fresh
 * transcript is saved (without `actorUserId` — assignees fall through to the
 * format/brand/global defaults).
 */
export async function generateClipIdeasForItem(
  productionItemId: string,
  options: ClipIdeaGenerateOptions = {},
): Promise<ClipIdeaGenerateOutcome> {
  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      platform: productionItems.platform,
      brand: productionItems.brand,
      postType: productionItems.postType,
      sourceType: productionItems.sourceType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) return { status: "skip", reason: "item-not-found" };

  if (!options.skipPostTypeGate) {
    if (item.sourceType !== "original") {
      return { status: "skip", reason: `source-type-${item.sourceType}` };
    }
    if (!item.postType || !AUTO_GENERATE_POST_TYPES.has(item.postType)) {
      return { status: "skip", reason: `post-type-${item.postType ?? "null"}` };
    }
  }

  // Idempotency: any existing batch for this pillar means a human already
  // triggered generation OR a prior auto-fire succeeded. Don't double-spend
  // Sonnet on the same transcript.
  const [existing] = await db
    .select({ id: clipIdeas.id })
    .from(clipIdeas)
    .where(eq(clipIdeas.sourceProductionItemId, productionItemId))
    .limit(1);
  if (existing) return { status: "skip", reason: "ideas-already-exist" };

  const transcript = await getTranscriptForPrompt(productionItemId);
  if (!transcript) return { status: "skip", reason: "no-transcript" };

  const assignees = options.actorUserId
    ? { producerUserId: options.actorUserId, editorUserId: options.actorUserId }
    : await resolveAssignees({
        brand: item.brand,
        sourceItemId: item.id,
        format: item.format,
      });

  // Derivatives of THIS pillar — direct children only, short-form. Matches
  // the manual route's framing.
  const derivativeRows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platform: productionItems.platform,
      format: productionItems.format,
      views: productionItems.views,
      hook: productionItems.hook,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.pillarContentItemId, productionItemId),
        isNotNull(productionItems.views),
        sql`(${productionItems.platform}::jsonb @> '["YouTube Shorts"]'::jsonb OR ${productionItems.platform}::jsonb @> '["Instagram Reel"]'::jsonb OR ${productionItems.platform}::jsonb @> '["TikTok"]'::jsonb)`,
      ),
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(20);

  const derivatives: PerfRow[] = derivativeRows
    .filter((d) => isShortForm(d.platform as string[] | null))
    .map((d) => ({
      title: d.title,
      platform: d.platform as string[] | null,
      format: d.format,
      views: d.views,
      hook: d.hook,
    }));

  const topPerfRows = await topShortFormPerformers({
    brand: item.brand,
    excludeDerivativesOfPillarId: productionItemId,
    limit: 30,
  });
  const topPerformers: PerfRow[] = topPerfRows.map((r) => ({
    title: r.title,
    platform: r.platform,
    format: r.format,
    views: r.views,
    hook: r.hook,
  }));

  const result = await generateClipIdeas({
    pillarTitle: item.title,
    pillarFormat: item.format,
    pillarChannels: item.platform,
    transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
    durationSec: transcript.durationSec,
    derivatives,
    topPerformers,
  });

  const batchId = randomUUID();

  const igAccount = await findAccountForBrandPlatform({
    brandSlug: item.brand,
    platform: "instagram",
  });

  const inserted = await db
    .insert(clipIdeas)
    .values(
      result.ideas.map((idea) => ({
        sourceProductionItemId: productionItemId,
        batchId,
        startSec: idea.startSec.toFixed(3),
        endSec: idea.endSec.toFixed(3),
        hook: idea.hook,
        angle: idea.angle,
        rationale: idea.rationale,
        estimatedViews: idea.estimatedViews,
        generatedBy: GENERATED_BY,
        promptVersion: PROMPT_VERSION,
        modelUsage: result.modelUsage,
        status: "suggested" as const,
      })),
    )
    .returning({
      id: clipIdeas.id,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      hook: clipIdeas.hook,
      angle: clipIdeas.angle,
      rationale: clipIdeas.rationale,
    });

  for (const ci of inserted) {
    const startSecNum = Number(ci.startSec);
    const endSecNum = Number(ci.endSec);
    const body = buildContentBody({
      sourceTitle: item.title,
      startSec: startSecNum,
      endSec: endSecNum,
      angle: ci.angle,
      rationale: ci.rationale,
    });

    const [created] = await db
      .insert(productionItems)
      .values({
        title: ci.hook,
        status: "Idea",
        platform: ["Instagram Reel"],
        postType: "instagram_reel",
        accountId: igAccount?.id ?? null,
        format: PROMOTED_CLIP_FORMAT,
        brand: item.brand,
        contentBody: body,
        pillarContentItemId: productionItemId,
        sourceType: "clip",
        sourceClipIdeaId: ci.id,
        producerUserId: assignees.producerUserId,
        editorUserId: assignees.editorUserId,
        hook: ci.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
      })
      .returning({ id: productionItems.id });

    if (created) {
      await db
        .update(clipIdeas)
        .set({ acceptedProductionItemId: created.id })
        .where(eq(clipIdeas.id, ci.id));
    }
  }

  return { status: "ok", ideasCreated: inserted.length, batchId };
}
