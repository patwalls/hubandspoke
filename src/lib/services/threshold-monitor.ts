/**
 * Threshold monitor for Starter Story content repurpose automation.
 *
 * The view threshold lives on the REPURPOSED (target) format, not the pillar.
 * Logic: "When pillar content exceeds the target format's Repurpose View Minimum,
 * create a task for that repurposed format."
 *
 * Example: "Business Breakdown → Full Video On X" has viewThreshold=50,000.
 * When a Business Breakdown video hits 50K views → create a "Full Video On X" task.
 *
 * Ships with DRY_RUN = true by default for safety.
 */

import { db } from "@/lib/db";
import {
  productionItems,
  formats,
  formatRepurposeMappings,
  repurposeTriggers,
  syncLogs,
} from "@/lib/db/schema";
import { eq, and, gt, isNotNull, inArray } from "drizzle-orm";
import { createNotionRepurposeTask } from "./notion-tasks";

// Safety: dry-run by default. Set env SS_AUTOMATION_LIVE=true to go live.
const DRY_RUN = process.env.SS_AUTOMATION_LIVE !== "true";
const MAX_TASKS_PER_RUN = 10;

export interface ThresholdMatch {
  itemId: string;
  itemTitle: string;
  itemViews: number;
  sourceFormatName: string;
  sourceFormatId: string;
  targetFormatName: string;
  targetFormatId: string;
  targetChannel?: string;
  targetFormatNotionPageId?: string;
  viewThreshold: number;
  pillarContentNotionId?: string;
  editorNotionUserId?: string;
  producerNotionUserId?: string;
}

export interface ThresholdCheckResult {
  dryRun: boolean;
  itemsChecked: number;
  thresholdsMatched: number;
  tasksCreated: number;
  skippedDuplicate: number;
  matches: ThresholdMatch[];
  errors: string[];
}

export async function checkSSThresholds(): Promise<ThresholdCheckResult> {
  const startedAt = new Date();
  const result: ThresholdCheckResult = {
    dryRun: DRY_RUN,
    itemsChecked: 0,
    thresholdsMatched: 0,
    tasksCreated: 0,
    skippedDuplicate: 0,
    matches: [],
    errors: [],
  };

  try {
    // 1. Get SS production items with views > 0, published, with a format
    const ssItems = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        views: productionItems.views,
        format: productionItems.format,
        notionId: productionItems.notionId,
        producerNotionUserId: productionItems.producerNotionUserId,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, "starter-story"),
          eq(productionItems.status, "Published"),
          isNotNull(productionItems.format),
          gt(productionItems.views, 0)
        )
      );

    result.itemsChecked = ssItems.length;

    // 2. Get ALL SS pillar formats (source side of mappings)
    const pillarFormats = await db
      .select()
      .from(formats)
      .where(
        and(
          eq(formats.brand, "starter-story"),
          eq(formats.contentType, "pillar")
        )
      );

    if (pillarFormats.length === 0) return result;

    // Build format name → format lookup (case-insensitive)
    const formatByName = new Map(
      pillarFormats.map((f) => [f.name.toLowerCase().trim(), f])
    );

    // 3. Get repurpose mappings for these pillar formats
    const pillarFormatIds = pillarFormats.map((f) => f.id);
    const mappings = await db
      .select({
        sourceFormatId: formatRepurposeMappings.sourceFormatId,
        targetFormatId: formatRepurposeMappings.targetFormatId,
      })
      .from(formatRepurposeMappings)
      .where(
        inArray(formatRepurposeMappings.sourceFormatId, pillarFormatIds)
      );

    if (mappings.length === 0) return result;

    // 4. Get target (repurposed) formats — threshold lives HERE
    const targetFormatIds = [...new Set(mappings.map((m) => m.targetFormatId))];
    const targetFormats = await db
      .select()
      .from(formats)
      .where(inArray(formats.id, targetFormatIds));

    const targetFormatMap = new Map(targetFormats.map((f) => [f.id, f]));

    // 5. Get existing triggers for dedup
    const existingTriggers = await db
      .select({
        productionItemId: repurposeTriggers.productionItemId,
        sourceFormatId: repurposeTriggers.sourceFormatId,
        targetFormatId: repurposeTriggers.targetFormatId,
      })
      .from(repurposeTriggers);

    const triggerSet = new Set(
      existingTriggers.map(
        (t) => `${t.productionItemId}|${t.sourceFormatId}|${t.targetFormatId}`
      )
    );

    // 6. Check each item against target format thresholds
    let tasksCreatedThisRun = 0;

    for (const item of ssItems) {
      if (!item.format || !item.views) continue;

      // Match item to its pillar (source) format
      const sourceFormat = formatByName.get(item.format.toLowerCase().trim());
      if (!sourceFormat) continue;

      // Get all repurpose mappings from this pillar format
      const itemMappings = mappings.filter(
        (m) => m.sourceFormatId === sourceFormat.id
      );

      for (const mapping of itemMappings) {
        const targetFormat = targetFormatMap.get(mapping.targetFormatId);
        if (!targetFormat) continue;

        // Threshold lives on the TARGET (repurposed) format
        if (!targetFormat.viewThreshold) continue;
        if (item.views < targetFormat.viewThreshold) continue;

        // Dedup check
        const dedupKey = `${item.id}|${mapping.sourceFormatId}|${mapping.targetFormatId}`;
        if (triggerSet.has(dedupKey)) {
          result.skippedDuplicate++;
          continue;
        }

        result.thresholdsMatched++;

        const match: ThresholdMatch = {
          itemId: item.id,
          itemTitle: item.title || "(Untitled)",
          itemViews: item.views,
          sourceFormatName: sourceFormat.name,
          sourceFormatId: sourceFormat.id,
          targetFormatName: targetFormat.name,
          targetFormatId: targetFormat.id,
          targetChannel: (targetFormat.channels as string[])?.[0],
          targetFormatNotionPageId: targetFormat.notionPageId || undefined,
          viewThreshold: targetFormat.viewThreshold,
          pillarContentNotionId: item.notionId || undefined,
          editorNotionUserId: targetFormat.editorNotionUserId || undefined,
          producerNotionUserId: targetFormat.producerNotionUserId || undefined,
        };

        result.matches.push(match);

        if (DRY_RUN) continue;

        // Safety cap
        if (tasksCreatedThisRun >= MAX_TASKS_PER_RUN) {
          result.errors.push(
            `Hit max tasks cap (${MAX_TASKS_PER_RUN}), stopping`
          );
          break;
        }

        // Create Notion task
        try {
          const taskResult = await createNotionRepurposeTask({
            pillarContentTitle: item.title || "(Untitled)",
            targetFormatName: targetFormat.name,
            channel: (targetFormat.channels as string[])?.[0],
            pillarContentNotionId: item.notionId || undefined,
            targetFormatNotionPageId: targetFormat.notionPageId || undefined,
            editorNotionUserId: targetFormat.editorNotionUserId || undefined,
            producerNotionUserId: targetFormat.producerNotionUserId || undefined,
          });

          if (taskResult.success) {
            // Record trigger for dedup
            await db.insert(repurposeTriggers).values({
              productionItemId: item.id,
              sourceFormatId: mapping.sourceFormatId,
              targetFormatId: mapping.targetFormatId,
              notionTaskPageId: taskResult.notionPageId || null,
              viewsAtTrigger: item.views,
            });

            // Add to dedup set so we don't double-trigger in same run
            triggerSet.add(dedupKey);
            tasksCreatedThisRun++;
            result.tasksCreated++;
          } else {
            result.errors.push(
              `Notion task failed for "${item.title}" → ${targetFormat.name}: ${taskResult.error}`
            );
          }
        } catch (err) {
          result.errors.push(
            `Error creating task for "${item.title}" → ${targetFormat.name}: ${String(err)}`
          );
        }
      }

      if (tasksCreatedThisRun >= MAX_TASKS_PER_RUN) break;
    }

    // Log sync
    await db.insert(syncLogs).values({
      syncType: "ss-threshold-check",
      status: result.errors.length > 0 && result.tasksCreated === 0 ? "error" : "success",
      itemsFetched: result.itemsChecked,
      itemsCreated: result.tasksCreated,
      errorMessage:
        result.errors.length > 0
          ? result.errors.join("; ")
          : DRY_RUN
            ? `DRY RUN: ${result.thresholdsMatched} matches found`
            : null,
      startedAt,
      completedAt: new Date(),
    });

    return result;
  } catch (err) {
    await db.insert(syncLogs).values({
      syncType: "ss-threshold-check",
      status: "error",
      errorMessage: String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}
