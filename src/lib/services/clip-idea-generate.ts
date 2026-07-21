import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  formatChannels,
  formats,
  productionItems,
} from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import { topShortFormPerformers } from "@/lib/db/queries";
import { findAccountForBrandPlatform } from "@/lib/db/accounts";
import { resolveEditor } from "@/lib/services/assignees";
import { recordItemCreated } from "@/lib/services/item-created";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import {
  extractClipIdeaSection,
  extractExtrasSchema,
} from "@/lib/format-skill";
import {
  detectClipSectionsForPillar,
  loadLiveSectionsForPillar,
  type LiveClipSection,
} from "@/lib/services/clip-sections-detect";
import {
  HOOK_GENERATED_BY,
  HOOK_PROMPT_VERSION,
  writeFormatHookForSection,
} from "@/lib/clip-hook-agent";

const HOOK_WRITER_CONCURRENCY = 5;

/**
 * Map a `production_items.post_type` value to the matching
 * `accounts.platform` key.
 */
function accountPlatformForPostType(postType: string | null): string | null {
  if (!postType) return null;
  if (postType.startsWith("instagram_")) return "instagram";
  if (postType.startsWith("youtube_")) return "youtube";
  if (postType === "x") return "x";
  if (postType === "tiktok") return "tiktok";
  if (postType === "linkedin") return "linkedin";
  if (postType === "threads") return "threads";
  return null;
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

/** Render the transcript cues that fall inside [startSec, endSec] as a
 *  pre-formatted excerpt the hook writer can read. Mirrors the [MM:SS]
 *  prefix style used in the full transcript prompt. */
function buildSectionExcerpt(
  segments: Array<{ startSec: number; endSec: number; text: string }>,
  startSec: number,
  endSec: number,
): string {
  const lines: string[] = [];
  for (const s of segments) {
    if (s.endSec < startSec || s.startSec > endSec) continue;
    lines.push(`[${formatTimestamp(s.startSec)}] ${s.text.trim()}`);
  }
  return lines.join("\n");
}

/** Concurrency-limited parallel mapper — caps in-flight promises at
 *  `limit` so we don't trip Anthropic's rate limit on a long pillar. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type ClipIdeaGenerateOutcome =
  | {
      status: "ok";
      ideasCreated: number;
      sectionsConsidered: number;
      sectionsSkipped: number;
      batchId: string;
      targetFormat: string;
    }
  | { status: "skip"; reason: string };

export interface ClipIdeaGenerateOptions {
  /** Required (since 2026-05-21 multi-format split). The clippable format
   *  this run targets. */
  targetFormatId: string;
  /** Caller for the resulting prod_items rows. */
  actorUserId?: string;
  /** Skip the post_type gate (manual route bypass). */
  skipPostTypeGate?: boolean;
  /** Bypass "(pillar, target_format) ideas already exist" idempotency. */
  force?: boolean;
  /** Re-detect sections from scratch. Kills the existing batch + its
   *  derived clip_ideas, runs section picker again. Implies `force`. */
  forceSections?: boolean;
}

/**
 * Two-pass clip-idea generation (Splice v10):
 *   1. Detect sections for the pillar via `detectClipSectionsForPillar`
 *      (Sonnet, format-agnostic, shared across all formats).
 *   2. For each section, ask a per-format Haiku hook writer if the
 *      format fits and to write the hook + extras if it does.
 *   3. Insert clip_ideas for eligible sections only; create paired
 *      production_items rows.
 *
 * The section batch is shared across all formats on the same pillar —
 * the second format's job finds sections already detected and skips
 * pass 1.
 */
export async function generateClipIdeasForItem(
  productionItemId: string,
  options: ClipIdeaGenerateOptions,
): Promise<ClipIdeaGenerateOutcome> {
  const AUTO_GENERATE_POST_TYPES = new Set(["youtube_long"]);

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

  const [format] = await db
    .select({
      id: formats.id,
      name: formats.name,
      brand: formats.brand,
      instructions: formats.instructions,
      isClippableFormat: formats.isClippableFormat,
      clipTargetPlatform: formats.clipTargetPlatform,
      clipTargetPostType: formats.clipTargetPostType,
    })
    .from(formats)
    .where(eq(formats.id, options.targetFormatId))
    .limit(1);
  if (!format) return { status: "skip", reason: "target-format-not-found" };
  if (format.brand !== item.brand) {
    return {
      status: "skip",
      reason: `target-format-wrong-brand-${format.brand}-vs-${item.brand}`,
    };
  }
  if (!format.isClippableFormat) {
    return {
      status: "skip",
      reason: `target-format-not-clippable-${format.name}`,
    };
  }

  // Idempotency: (pillar, target_format) — independent per format.
  if (!options.force && !options.forceSections) {
    const [existing] = await db
      .select({ id: clipIdeas.id })
      .from(clipIdeas)
      .where(
        and(
          eq(clipIdeas.sourceProductionItemId, productionItemId),
          eq(clipIdeas.targetFormat, format.name),
        ),
      )
      .limit(1);
    if (existing) {
      return { status: "skip", reason: "ideas-already-exist-for-format" };
    }
  }

  // Pass 1: ensure sections. Idempotent — if a live batch exists, reuse.
  const sectionsOutcome = await detectClipSectionsForPillar(productionItemId, {
    force: options.forceSections === true,
    killedByUserId: options.actorUserId ?? null,
  });
  if (sectionsOutcome.status !== "ok") {
    return { status: "skip", reason: `sections-${sectionsOutcome.reason}` };
  }

  const liveSections = await loadLiveSectionsForPillar(productionItemId);
  if (liveSections.length === 0) {
    return { status: "skip", reason: "no-sections-after-detection" };
  }

  // Load transcript (for word-level data the hook writer needs to
  // re-resolve narrowed anchor ranges).
  const transcript = await getTranscriptForPrompt(productionItemId);
  if (!transcript) return { status: "skip", reason: "no-transcript" };

  // Parse format skill section + extras schema.
  const clipIdeaSection = extractClipIdeaSection(format.instructions ?? "");
  const extrasSchema = clipIdeaSection
    ? extractExtrasSchema(clipIdeaSection, (msg) => {
        console.warn(
          `[clip-idea-generate] format=${format.name} bad extras-schema in skill: ${msg}`,
        );
      })
    : null;

  // Reference hooks for THIS format. Top performers, with the rich payload
  // unused here — the hook writer just needs hooks + view counts.
  const restrictPlatforms =
    format.clipTargetPlatform &&
    Array.isArray(format.clipTargetPlatform) &&
    format.clipTargetPlatform.length > 0
      ? (format.clipTargetPlatform as string[])
      : undefined;
  const { blueprint } = await topShortFormPerformers({
    brand: item.brand,
    excludeDerivativesOfPillarId: productionItemId,
    preferredFormat: format.name,
    restrictPlatforms,
    blueprintLimit: 8,
    benchLimit: 0,
  });
  const referenceHooks = blueprint
    .filter((r) => r.hook && r.hook.trim() !== "")
    .map((r) => ({ hook: r.hook as string, views: r.views }));

  // Pass 2: per-(section, format) hook writer, parallel with concurrency cap.
  const editorUserId =
    options.actorUserId ??
    (await resolveEditor({
      brand: item.brand,
      sourceItemId: item.id,
      format: format.name,
    }));

  const candidates = await mapWithConcurrency(
    liveSections,
    HOOK_WRITER_CONCURRENCY,
    (section) =>
      writeFormatHookForSection({
        formatName: format.name,
        formatSkillSection: clipIdeaSection,
        extrasSchema,
        referenceHooks,
        section: {
          id: section.id,
          startSec: section.startSec,
          endSec: section.endSec,
          transcriptAnchorQuote: section.transcriptAnchorQuote,
          transcriptAnchorStartSec: section.transcriptAnchorStartSec,
          topic: section.topic,
          summary: section.summary,
          themeTags: section.themeTags,
          estimatedViewsBaseline: section.estimatedViewsBaseline,
          transcriptExcerpt: buildSectionExcerpt(
            transcript.segments,
            section.startSec,
            section.endSec,
          ),
        },
        transcriptWords: transcript.words,
        transcriptSegments: transcript.segments,
        pillarDurationSec: transcript.durationSec,
      }),
  );

  const eligible: Array<{
    section: LiveClipSection;
    candidate: (typeof candidates)[number]["candidate"];
  }> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (let i = 0; i < candidates.length; i++) {
    totalInputTokens += candidates[i].modelUsage.input_tokens;
    totalOutputTokens += candidates[i].modelUsage.output_tokens;
    const c = candidates[i].candidate;
    if (c.eligible) {
      eligible.push({ section: liveSections[i], candidate: c });
    } else {
      console.info(
        `[clip-idea-generate] section "${liveSections[i].topic}" skipped for format "${format.name}": ${c.reason}`,
      );
    }
  }

  if (eligible.length === 0) {
    return {
      status: "ok",
      ideasCreated: 0,
      sectionsConsidered: liveSections.length,
      sectionsSkipped: liveSections.length,
      batchId: sectionsOutcome.batchId,
      targetFormat: format.name,
    };
  }

  // Resolve target account for the new production_items rows.
  // If clipTargetPostType is set, look for a format_channels row matching that
  // post type. If null, fall back to the first format_channels row for this
  // format (any post type) so we don't accidentally default to instagram_reel.
  let targetPostType: string = "instagram_reel";
  let targetAccountId: string | null = null;
  if (format.clipTargetPostType) {
    const [fcRow] = await db
      .select({ accountId: formatChannels.accountId })
      .from(formatChannels)
      .where(
        and(
          eq(formatChannels.formatId, format.id),
          eq(formatChannels.postType, format.clipTargetPostType),
        ),
      )
      .limit(1);
    targetPostType = format.clipTargetPostType;
    if (fcRow) {
      targetAccountId = fcRow.accountId;
    }
  } else {
    // clipTargetPostType not set — use the first format_channels row to
    // derive both the post type and account, rather than hardcoding instagram_reel.
    const [fcRow] = await db
      .select({ accountId: formatChannels.accountId, postType: formatChannels.postType })
      .from(formatChannels)
      .where(eq(formatChannels.formatId, format.id))
      .limit(1);
    if (fcRow?.postType) {
      targetPostType = fcRow.postType;
      targetAccountId = fcRow.accountId;
    }
  }
  if (!targetAccountId) {
    const platformKey = accountPlatformForPostType(targetPostType);
    if (platformKey) {
      const acc = await findAccountForBrandPlatform({
        brandSlug: item.brand,
        platform: platformKey,
      });
      targetAccountId = acc?.id ?? null;
    }
  }
  const targetPlatform =
    format.clipTargetPlatform &&
    Array.isArray(format.clipTargetPlatform) &&
    format.clipTargetPlatform.length > 0
      ? (format.clipTargetPlatform as string[])
      : null;

  const batchId = randomUUID();
  const aggregatedUsage = {
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    hook_writer_calls: candidates.length,
  };

  // Insert clip_ideas (eligible only) + paired production_items.
  const inserted = await db
    .insert(clipIdeas)
    .values(
      eligible.map(({ section, candidate }) => ({
        sourceProductionItemId: productionItemId,
        clipSectionId: section.id,
        targetFormat: format.name,
        batchId,
        startSec: candidate.startSec.toFixed(3),
        endSec: candidate.endSec.toFixed(3),
        hook: candidate.hook ?? "",
        angle: candidate.angle ?? "",
        rationale: candidate.rationale ?? "",
        blueprintAnchorHook: candidate.blueprintAnchorHook,
        transcriptAnchorQuote: candidate.transcriptAnchorQuote,
        transcriptAnchorStartSec:
          candidate.transcriptAnchorStartSec != null
            ? candidate.transcriptAnchorStartSec.toFixed(3)
            : null,
        estimatedViews: candidate.estimatedViews,
        generatedBy: HOOK_GENERATED_BY,
        promptVersion: HOOK_PROMPT_VERSION,
        modelUsage: aggregatedUsage,
        extras: candidate.extras,
        eligibilityReason: candidate.reason,
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
        platform: targetPlatform,
        postType: targetPostType,
        accountId: targetAccountId,
        format: format.name,
        brand: item.brand,
        contentBody: body,
        pillarContentItemId: productionItemId,
        sourceType: "repurposed",
        sourceClipIdeaId: ci.id,
        editorUserId,
        utmCampaign: await generateUtmCampaign(ci.hook),
        hook: ci.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
        createdVia: "service:clip-idea-generate",
      })
      .returning({ id: productionItems.id });
    if (created) {
      try {
        await recordItemCreated(db, {
          itemId: created.id,
          source: "service:clip-idea-generate",
          actorUserId: null,
          format: format.name,
          sourceType: "repurposed",
          postType: targetPostType,
        });
      } catch (err) {
        console.error(
          "[service:clip-idea-generate] recordItemCreated failed",
          err,
        );
      }
      await db
        .update(clipIdeas)
        .set({ acceptedProductionItemId: created.id })
        .where(eq(clipIdeas.id, ci.id));
    }
  }

  return {
    status: "ok",
    ideasCreated: inserted.length,
    sectionsConsidered: liveSections.length,
    sectionsSkipped: liveSections.length - eligible.length,
    batchId,
    targetFormat: format.name,
  };
}
