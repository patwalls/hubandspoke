import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crossPostRules, productionItems, syncLogs } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { isNotionAuthoritative } from "@/lib/platform";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { classifyCrossPostFit } from "@/lib/services/cross-post-fit-classifier";

// Cap flood risk: only consider items published within the last N days on the
// first pass. Older evergreen content rides the existing repost queue. Tunable.
const RECENCY_WINDOW_DAYS = 180;

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

  for (const rule of rules) {
    result.rulesEvaluated++;

    // Candidates: published originals on sourcePlatform with views >= threshold
    // and published within the recency window.
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
        crossPostFitGood: productionItems.crossPostFitGood,
        crossPostFitCheckedAt: productionItems.crossPostFitCheckedAt,
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

    for (const candidate of candidates) {
      result.candidatesConsidered++;

      // Don't cross-post back to a platform the original already covers.
      const existingPlatforms = (candidate.platform ?? []) as string[];
      if (existingPlatforms.includes(rule.targetPlatform)) {
        result.skippedExisting++;
        continue;
      }

      // Skip if we've already queued (or posted) a cross-post of this source
      // targeting this platform.
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

      // Target platform may itself be Notion-authoritative long-form — skip.
      if (isNotionAuthoritative([rule.targetPlatform])) {
        result.skippedExisting++;
        continue;
      }

      // LLM fit gate. Classify each source item exactly once — cached verdict
      // lives on the row and is reused on subsequent scans. Skip the model
      // call entirely when contentBody is empty (scanner falls back to the
      // view-threshold heuristic). On model/API errors we fail open and
      // don't cache, so a transient failure gets retried next run.
      if (candidate.crossPostFitGood === false) {
        result.skippedByLlm++;
        continue;
      }

      if (
        candidate.crossPostFitCheckedAt === null &&
        candidate.contentBody !== null &&
        candidate.contentBody.trim().length > 0
      ) {
        const verdict = await classifyCrossPostFit({
          title: candidate.title,
          contentBody: candidate.contentBody,
          sourcePlatform: rule.sourcePlatform,
          publishedDate: candidate.publishedDate,
          format: candidate.format,
          brand: candidate.brand,
        });

        if (!verdict.isFallback) {
          const now = new Date();
          await db
            .update(productionItems)
            .set({
              crossPostFitGood: verdict.isGoodFit,
              crossPostFitReasoning: verdict.reasoning,
              crossPostFitCheckedAt: now,
              updatedAt: now,
            })
            .where(eq(productionItems.id, candidate.id));

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
