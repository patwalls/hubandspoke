/**
 * Threshold monitor for Starter Story content repurpose automation.
 *
 * Formats form a tree via parentFormatId. When a production item's views
 * exceed any of its format's CHILDREN's viewThreshold, we create a task for
 * that child format — then when the child's own content eventually hits its
 * grandchild's threshold, the chain continues.
 *
 * Ships with DRY_RUN = true by default for safety.
 */

import { db } from "@/lib/db";
import {
  productionItems,
  formats,
  repurposeTriggers,
  syncLogs,
} from "@/lib/db/schema";
import { eq, and, gt, isNotNull } from "drizzle-orm";
import { createNotionRepurposeTask } from "./notion-tasks";

// Safety: dry-run by default. Set env SS_AUTOMATION_LIVE=true to go live.
const DRY_RUN = process.env.SS_AUTOMATION_LIVE !== "true";
const MAX_TASKS_PER_RUN = 50;

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

    // 2. Get every SS format; build a parent → direct-children index and
    //    a name → format lookup. Any format can now be a source.
    const brandFormats = await db
      .select()
      .from(formats)
      .where(eq(formats.brand, "starter-story"));

    if (brandFormats.length === 0) return result;

    const formatByName = new Map(
      brandFormats.map((f) => [f.name.toLowerCase().trim(), f])
    );

    const childrenByParent = new Map<string, typeof brandFormats>();
    for (const f of brandFormats) {
      if (!f.parentFormatId) continue;
      const arr = childrenByParent.get(f.parentFormatId) ?? [];
      arr.push(f);
      childrenByParent.set(f.parentFormatId, arr);
    }

    // 3. Get existing triggers for dedup
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

    // 3b. Load existing (pillar, format) pairs so we don't create a Notion
    //     task for a derivative a human already made manually — the DB's
    //     uniq_production_items_pillar_format index would reject it on sync.
    const existingChildren = await db
      .select({
        pillarContentItemId: productionItems.pillarContentItemId,
        format: productionItems.format,
      })
      .from(productionItems)
      .where(
        and(
          isNotNull(productionItems.pillarContentItemId),
          isNotNull(productionItems.format)
        )
      );

    const childPairSet = new Set(
      existingChildren
        .filter((c) => c.pillarContentItemId && c.format)
        .map(
          (c) => `${c.pillarContentItemId}|${c.format!.toLowerCase().trim()}`
        )
    );

    // 4. Check each item against its format's direct-children thresholds
    let tasksCreatedThisRun = 0;

    for (const item of ssItems) {
      if (!item.format || !item.views) continue;

      const sourceFormat = formatByName.get(item.format.toLowerCase().trim());
      if (!sourceFormat) continue;

      const children = childrenByParent.get(sourceFormat.id) ?? [];

      for (const targetFormat of children) {
        if (!targetFormat.viewThreshold) continue;
        if (item.views < targetFormat.viewThreshold) continue;

        // Dedup check — trigger row from a prior run
        const dedupKey = `${item.id}|${sourceFormat.id}|${targetFormat.id}`;
        if (triggerSet.has(dedupKey)) {
          result.skippedDuplicate++;
          continue;
        }

        // Dedup check — a child with this (pillar, format) already exists.
        // Record a trigger row so we don't re-query this pair on every run.
        const childPairKey = `${item.id}|${targetFormat.name.toLowerCase().trim()}`;
        if (childPairSet.has(childPairKey)) {
          result.skippedDuplicate++;
          if (!DRY_RUN) {
            try {
              await db.insert(repurposeTriggers).values({
                productionItemId: item.id,
                sourceFormatId: sourceFormat.id,
                targetFormatId: targetFormat.id,
                notionTaskPageId: null,
                viewsAtTrigger: item.views,
              });
              triggerSet.add(dedupKey);
            } catch (err) {
              result.errors.push(
                `Failed to backfill trigger for existing child "${item.title}" / ${targetFormat.name}: ${String(err)}`
              );
            }
          }
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

        if (tasksCreatedThisRun >= MAX_TASKS_PER_RUN) {
          result.errors.push(
            `Hit max tasks cap (${MAX_TASKS_PER_RUN}), stopping`
          );
          break;
        }

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
            await db.insert(repurposeTriggers).values({
              productionItemId: item.id,
              sourceFormatId: sourceFormat.id,
              targetFormatId: targetFormat.id,
              notionTaskPageId: taskResult.notionPageId || null,
              viewsAtTrigger: item.views,
            });

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
