import type { Task } from "graphile-worker";
import { and, eq, gt, isNotNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productionItems,
  formats,
  repurposeTriggers,
  formatChannels,
  accounts,
} from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";

/**
 * Threshold monitor: scan all published items and automatically create
 * repurposed content items when view counts cross format thresholds.
 *
 * For each published item with views:
 * 1. Get its format's child formats (repurpose targets)
 * 2. Check if views exceed each child's viewThreshold
 * 3. If yes and no existing trigger, create a new production_items row
 *    with sourceType="repurposed", pillarContentItemId=parent, format=child
 * 4. Record the trigger to prevent re-queueing on future runs
 */
export const thresholdMonitorSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("threshold-monitor-sweep start");

  let itemsChecked = 0;
  let itemsCreated = 0;
  let skippedDuplicate = 0;
  const errors: string[] = [];

  try {
    // 1. Get all published items with views and a format
    const publishedItems = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        thumbnail: productionItems.thumbnail,
        views: productionItems.views,
        format: productionItems.format,
        brand: productionItems.brand,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.status, "Published"),
          isNotNull(productionItems.format),
          gt(productionItems.views, 0)
        )
      );

    itemsChecked = publishedItems.length;
    helpers.logger.info(`Found ${itemsChecked} published items with views`);

    // 2. Get all formats and build index
    const allFormats = await db.select().from(formats);
    const formatByName = new Map(
      allFormats.map((f) => [f.name.toLowerCase().trim(), f])
    );

    const childrenByParent = new Map<string, typeof allFormats>();
    for (const f of allFormats) {
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

    // 4. Check each item against its format's children thresholds
    for (const item of publishedItems) {
      if (!item.format || !item.views) continue;

      const sourceFormat = formatByName.get(
        item.format.toLowerCase().trim()
      );
      if (!sourceFormat) continue;

      const children = childrenByParent.get(sourceFormat.id) ?? [];

      for (const targetFormat of children) {
        // Skip if no threshold set or views below threshold
        if (!targetFormat.viewThreshold || item.views < targetFormat.viewThreshold) {
          continue;
        }

        // Dedup check
        const dedupKey = `${item.id}|${sourceFormat.id}|${targetFormat.id}`;
        if (triggerSet.has(dedupKey)) {
          skippedDuplicate++;
          continue;
        }

        try {
          // Resolve assignees for this brand/format
          const assignees = await resolveAssignees({
            brand: item.brand,
            sourceItemId: item.id,
            format: targetFormat.name,
          });

          // Look up the account for this format (if configured)
          const [formatChannel] = await db
            .select({ accountId: formatChannels.accountId })
            .from(formatChannels)
            .where(eq(formatChannels.formatId, targetFormat.id))
            .limit(1);

          // Create the repurposed production item
          // Title follows the pattern: "SourceFormat → TargetFormat (OriginalTitle)"
          const repurposedTitle = `${sourceFormat.name} → ${targetFormat.name} (${item.title})`;

          const [created] = await db
            .insert(productionItems)
            .values({
              brand: item.brand,
              title: repurposedTitle,
              thumbnail: item.thumbnail,
              status: "Idea",
              format: targetFormat.name,
              sourceType: "repurposed",
              pillarContentItemId: item.id,
              accountId: formatChannel?.accountId ?? null,
              producerUserId: assignees.producerUserId,
              editorUserId: assignees.editorUserId,
              utmCampaign: await generateUtmCampaign(item.title),
            })
            .returning({ id: productionItems.id });

          if (created) {
            // Record the trigger to prevent re-queueing
            await db.insert(repurposeTriggers).values({
              productionItemId: item.id,
              sourceFormatId: sourceFormat.id,
              targetFormatId: targetFormat.id,
              viewsAtTrigger: item.views,
            });

            itemsCreated++;
            helpers.logger.debug(
              `Created repurposed item: ${targetFormat.name} from ${item.title} (${item.views} views)`
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(
            `Failed to create ${targetFormat.name} for ${item.id}: ${msg}`
          );
          helpers.logger.error(msg);
        }
      }
    }

    helpers.logger.info(
      `threshold-monitor-sweep done (${Date.now() - start}ms): checked=${itemsChecked}, created=${itemsCreated}, skipped=${skippedDuplicate}, errors=${errors.length}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    helpers.logger.error(`threshold-monitor-sweep failed: ${msg}`);
    throw err;
  }
};
