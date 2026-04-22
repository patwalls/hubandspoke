import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentEvents,
  crossPostFitVerdicts,
  crossPostRules,
  productionItemMedia,
  productionItems,
  syncLogs,
} from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritative } from "@/lib/platform";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import {
  classifyCrossPostFit,
  type PastCrossPostKill,
} from "@/lib/services/cross-post-fit-classifier";

// Cap flood risk: only consider items published within the last N days on the
// first pass. Older evergreen content rides the existing repost queue. Tunable.
const RECENCY_WINDOW_DAYS = 180;

// How many recent operator kill reasons to feed into the classifier's system
// prompt. Matches KILL_REASON_HISTORY in evergreen-scan.ts.
const KILL_REASON_HISTORY = 10;

export interface CrossPostScanResult {
  rulesEvaluated: number;
  candidatesConsidered: number;
  suggestionsCreated: number;
  skippedExisting: number;
  skippedByLlm: number;
  classifiedThisRun: number;
  suggestionsDetails: Array<{
    ruleId: string;
    sourceItemId: string;
    newItemId: string;
    targetPlatform: string;
    title: string;
  }>;
}

interface MediaSignals {
  hasVideo: boolean;
  hasImage: boolean;
  mediaCount: number;
}

/**
 * For each active cross-post rule, scan published originals on the source
 * platform whose views cleared the rule's threshold and that don't already
 * have a cross-post row for the target platform. Queue a new cross-post idea
 * for each match.
 *
 * Idempotent: re-running skips any (source_item, target_platform) pair that
 * already has a cross_post row pointing at it.
 */
export async function runCrossPostScan(): Promise<CrossPostScanResult> {
  const result: CrossPostScanResult = {
    rulesEvaluated: 0,
    candidatesConsidered: 0,
    suggestionsCreated: 0,
    skippedExisting: 0,
    skippedByLlm: 0,
    classifiedThisRun: 0,
    suggestionsDetails: [],
  };

  const rules = await db
    .select()
    .from(crossPostRules)
    .where(eq(crossPostRules.active, true));

  if (rules.length === 0) return result;

  const pastKillReasons = await fetchPastCrossPostKillReasons();

  for (const rule of rules) {
    result.rulesEvaluated++;

    const candidates = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        thumbnail: productionItems.thumbnail,
        platform: productionItems.platform,
        views: productionItems.views,
        brand: productionItems.brand,
        publishedDate: productionItems.publishedDate,
        format: productionItems.format,
        pillarContentNotionId: productionItems.pillarContentNotionId,
        pillarContentItemId: productionItems.pillarContentItemId,
        contentBody: productionItems.contentBody,
        mediaContentType: productionItems.mediaContentType,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, rule.brand),
          eq(productionItems.sourceType, "original"),
          eq(productionItems.status, "Published"),
          gte(productionItems.views, rule.viewThreshold),
          sql`${productionItems.platform} ? ${rule.sourcePlatform}`,
          gte(
            productionItems.publishedDate,
            sql`(now() - interval '${sql.raw(String(RECENCY_WINDOW_DAYS))} days')::date`
          )
        )
      );

    if (candidates.length === 0) continue;

    const candidateIds = candidates.map((c) => c.id);
    const mediaByItem = await fetchMediaSignals(candidateIds);
    const verdictsByItem = await fetchCachedVerdicts(
      candidateIds,
      rule.targetPlatform
    );

    for (const candidate of candidates) {
      result.candidatesConsidered++;

      const existingPlatforms = (candidate.platform ?? []) as string[];
      if (existingPlatforms.includes(rule.targetPlatform)) {
        result.skippedExisting++;
        continue;
      }

      const existing = await db
        .select({ id: productionItems.id })
        .from(productionItems)
        .where(
          and(
            eq(productionItems.sourceType, "cross_post"),
            eq(productionItems.repostedFromItemId, candidate.id),
            sql`${productionItems.platform} ? ${rule.targetPlatform}`
          )
        )
        .limit(1);

      if (existing.length > 0) {
        result.skippedExisting++;
        continue;
      }

      if (isNotionAuthoritative([rule.targetPlatform])) {
        result.skippedExisting++;
        continue;
      }

      // LLM fit gate — per (source item × target platform). Verdicts are
      // cached in crossPostFitVerdicts; a cached bad verdict skips the call,
      // a cached good verdict proceeds without calling, absence triggers a
      // fresh classification whose result is upserted.
      const cachedVerdict = verdictsByItem.get(candidate.id);
      const media = mediaByItem.get(candidate.id) ?? deriveMediaFromItem(candidate.mediaContentType);

      if (cachedVerdict === false) {
        result.skippedByLlm++;
        continue;
      }

      if (
        cachedVerdict === undefined &&
        candidate.contentBody !== null &&
        candidate.contentBody.trim().length > 0
      ) {
        const verdict = await classifyCrossPostFit({
          title: candidate.title,
          contentBody: candidate.contentBody,
          sourcePlatform: rule.sourcePlatform,
          targetPlatform: rule.targetPlatform,
          publishedDate: candidate.publishedDate,
          format: candidate.format,
          brand: candidate.brand,
          hasVideo: media.hasVideo,
          hasImage: media.hasImage,
          mediaCount: media.mediaCount,
          pastKillReasons,
        });

        if (!verdict.isFallback) {
          const now = new Date();
          await db
            .insert(crossPostFitVerdicts)
            .values({
              sourceItemId: candidate.id,
              targetPlatform: rule.targetPlatform,
              isGoodFit: verdict.isGoodFit,
              reasoning: verdict.reasoning,
              checkedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                crossPostFitVerdicts.sourceItemId,
                crossPostFitVerdicts.targetPlatform,
              ],
              set: {
                isGoodFit: verdict.isGoodFit,
                reasoning: verdict.reasoning,
                checkedAt: now,
              },
            });

          result.classifiedThisRun++;

          await db.insert(syncLogs).values({
            syncType: "cross-post-scan",
            status: "success",
            errorMessage: `classified item=${candidate.id} verdict=${
              verdict.isGoodFit ? "good" : "bad"
            } target=${rule.targetPlatform} reason=${verdict.reasoning}`,
            startedAt: now,
            completedAt: now,
          });
        }

        if (!verdict.isGoodFit) {
          result.skippedByLlm++;
          continue;
        }
      }

      const assignees = await resolveAssignees({
        brand: candidate.brand,
        sourceItemId: candidate.id,
        format: candidate.format,
      });

      const [inserted] = await db
        .insert(productionItems)
        .values({
          brand: candidate.brand,
          title: candidate.title,
          thumbnail: candidate.thumbnail,
          status: "Idea",
          platform: [rule.targetPlatform],
          sourceType: "cross_post",
          repostedFromItemId: candidate.id,
          format: candidate.format,
          pillarContentNotionId: candidate.pillarContentNotionId,
          pillarContentItemId: candidate.pillarContentItemId,
          utmCampaign: await generateUtmCampaign(candidate.title),
          producerUserId: assignees.producerUserId,
          editorUserId: assignees.editorUserId,
        })
        .returning({ id: productionItems.id });

      result.suggestionsCreated++;
      result.suggestionsDetails.push({
        ruleId: rule.id,
        sourceItemId: candidate.id,
        newItemId: inserted.id,
        targetPlatform: rule.targetPlatform,
        title: candidate.title ?? "(untitled)",
      });
    }
  }

  return result;
}

async function fetchMediaSignals(
  itemIds: string[]
): Promise<Map<string, MediaSignals>> {
  const map = new Map<string, MediaSignals>();
  if (itemIds.length === 0) return map;

  const rows = await db
    .select({
      productionItemId: productionItemMedia.productionItemId,
      kind: productionItemMedia.kind,
    })
    .from(productionItemMedia)
    .where(inArray(productionItemMedia.productionItemId, itemIds));

  for (const row of rows) {
    const existing = map.get(row.productionItemId) ?? {
      hasVideo: false,
      hasImage: false,
      mediaCount: 0,
    };
    if (row.kind === "video") existing.hasVideo = true;
    if (row.kind === "image") existing.hasImage = true;
    existing.mediaCount += 1;
    map.set(row.productionItemId, existing);
  }

  return map;
}

function deriveMediaFromItem(mediaContentType: string | null): MediaSignals {
  // Fallback for pre-carousel-enrichment rows: infer from the legacy
  // single-media mediaContentType column. No row means we simply don't know.
  if (!mediaContentType) {
    return { hasVideo: false, hasImage: false, mediaCount: 0 };
  }
  const isVideo = mediaContentType.startsWith("video/");
  const isImage = mediaContentType.startsWith("image/");
  return {
    hasVideo: isVideo,
    hasImage: isImage,
    mediaCount: isVideo || isImage ? 1 : 0,
  };
}

async function fetchCachedVerdicts(
  itemIds: string[],
  targetPlatform: string
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (itemIds.length === 0) return map;

  const rows = await db
    .select({
      sourceItemId: crossPostFitVerdicts.sourceItemId,
      isGoodFit: crossPostFitVerdicts.isGoodFit,
    })
    .from(crossPostFitVerdicts)
    .where(
      and(
        inArray(crossPostFitVerdicts.sourceItemId, itemIds),
        eq(crossPostFitVerdicts.targetPlatform, targetPlatform)
      )
    );

  for (const row of rows) map.set(row.sourceItemId, row.isGoodFit);
  return map;
}

async function fetchPastCrossPostKillReasons(): Promise<PastCrossPostKill[]> {
  // Join contentEvents → productionItems to find recently-killed cross-posts
  // and tag each reason with the *target* platform that got killed. That's
  // what the classifier needs to learn "don't pair videos with YouTube
  // Community again" without us hand-coding the rule.
  const rows = await db
    .select({
      reason: sql<string>`${contentEvents.payload}->>'reason'`,
      platform: productionItems.platform,
    })
    .from(contentEvents)
    .innerJoin(
      productionItems,
      eq(productionItems.id, contentEvents.contentItemId)
    )
    .where(
      and(
        eq(productionItems.sourceType, "cross_post"),
        sql`${contentEvents.payload}->>'type' = 'killed'`,
        sql`${contentEvents.payload}->>'reason' IS NOT NULL`,
        sql`length(${contentEvents.payload}->>'reason') >= 10`
      )
    )
    .orderBy(desc(contentEvents.createdAt))
    .limit(KILL_REASON_HISTORY);

  return rows.map((r) => ({
    reason: r.reason,
    targetPlatform: ((r.platform ?? []) as string[])[0] ?? null,
  }));
}
