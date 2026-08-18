import type { Task } from "graphile-worker";
import { and, asc, eq, gt, gte, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  productionItems,
  formats,
  repurposeTriggers,
  formatChannels,
  formatTriggerSources,
} from "@/lib/db/schema";
import { resolveEditor } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { enqueue } from "@/jobs/enqueue";
import { recordItemCreated } from "@/lib/services/item-created";

/**
 * Threshold monitor: scan all published items and automatically create
 * repurposed content items when view counts cross format thresholds.
 *
 * Two routing paths run in parallel and feed the same candidate map:
 *
 * 1. Root formats (no parentFormatId): routed via `format_trigger_sources`.
 *    Any published item from a configured source account is eligible —
 *    no post_type constraint. Same behavior as the original account-based
 *    routing model.
 *
 * 2. Derivative formats (have parentFormatId): routed exclusively via the
 *    direct parent format's `format_channels`. A production item is only
 *    eligible if BOTH its accountId and postType match a row on the parent's
 *    channels. `format_trigger_sources` entries for derivative formats are
 *    completely ignored — they cannot broaden the eligible source accounts.
 *    This means a Howfinity video cannot trigger a Futurepedia derivative
 *    simply because someone added a trigger source row; the parent format's
 *    channel config is the single source of truth.
 *
 * Dedup key: (productionItemId, targetFormatId). One triggered item per
 * (pillar, target format) pair regardless of source format.
 *
 * TRIGGER_ROUTING_MIN_PUBLISHED_AT (required): permanent lower bound on
 * pillar published_at for account-based trigger evaluation. Set once at
 * first deployment to 7 days prior (e.g. "2026-08-03T00:00:00Z") to allow
 * a one-time catch-up window. Leave it set permanently — it is the guard
 * that prevents the historical catalog from ever becoming eligible. If this
 * env var is absent the sweep logs a warning and skips all trigger
 * evaluation (safe lockout, not a pass-through). Never unset it.
 */
export const thresholdMonitorSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("threshold-monitor-sweep start");

  let itemsChecked = 0;
  let itemsCreated = 0;
  let skippedDuplicate = 0;
  const errors: string[] = [];

  // Required permanent lower bound. Absent = safety lockout (no triggers fire).
  // Set once at deployment to (now - 7d); leave set forever so historical
  // items can never become eligible without an explicit env var change.
  const minPublishedAtIso = process.env.TRIGGER_ROUTING_MIN_PUBLISHED_AT;
  if (!minPublishedAtIso) {
    helpers.logger.warn(
      "threshold-monitor-sweep: TRIGGER_ROUTING_MIN_PUBLISHED_AT is not set — " +
        "skipping account-based trigger evaluation. " +
        "Set this env var to enable (e.g. heroku config:set TRIGGER_ROUTING_MIN_PUBLISHED_AT=<iso>)."
    );
    return;
  }
  const minPublishedAt = new Date(minPublishedAtIso);

  try {
    // 1. Get all published items with views, a source account, and a
    //    published_at on or after the permanent lower bound.
    //    format is no longer required — routing is by account_id now.
    const publishedItems = await db
      .select({
        id: productionItems.id,
        title: productionItems.title,
        thumbnail: productionItems.thumbnail,
        views: productionItems.views,
        brand: productionItems.brand,
        accountId: productionItems.accountId,
        postType: productionItems.postType,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.status, "Published"),
          isNotNull(productionItems.accountId),
          gt(productionItems.views, 0),
          gte(productionItems.publishedAt, minPublishedAt),
        )
      );

    itemsChecked = publishedItems.length;
    helpers.logger.info(`Found ${itemsChecked} published items with views`);

    // 2. Build the routing map: sourceAccountId → [target format descriptors].
    //    Two separate queries feed the same map — see the module docstring.

    // 2a. Root formats: routed via format_trigger_sources (no post_type constraint).
    const rootRows = await db
      .select({
        sourceAccountId: formatTriggerSources.sourceAccountId,
        id: formats.id,
        name: formats.name,
        viewThreshold: formats.viewThreshold,
        isClippableFormat: formats.isClippableFormat,
        brand: formats.brand,
      })
      .from(formatTriggerSources)
      .innerJoin(
        formats,
        and(
          eq(formats.id, formatTriggerSources.formatId),
          isNull(formats.parentFormatId),
        ),
      );

    // 2b. Derivative formats: routed via the direct parent's format_channels.
    //     format_trigger_sources is ignored — the parent's channels are the
    //     sole source of eligible (account, post_type) pairs.
    const parentFormats = alias(formats, "parent_formats");
    const derivativeRows = await db
      .select({
        sourceAccountId: formatChannels.accountId,
        id: formats.id,
        name: formats.name,
        viewThreshold: formats.viewThreshold,
        isClippableFormat: formats.isClippableFormat,
        brand: formats.brand,
        requiredSourcePostType: formatChannels.postType,
      })
      .from(formats)
      .innerJoin(parentFormats, eq(parentFormats.id, formats.parentFormatId))
      .innerJoin(formatChannels, eq(formatChannels.formatId, parentFormats.id))
      .where(isNotNull(formats.parentFormatId));

    const targetFormatsByAccount = new Map<
      string,
      Array<{
        id: string;
        name: string;
        viewThreshold: number | null;
        isClippableFormat: boolean;
        brand: string;
        requiredSourcePostType: string | null;
      }>
    >();
    for (const row of rootRows) {
      const arr = targetFormatsByAccount.get(row.sourceAccountId) ?? [];
      arr.push({
        id: row.id,
        name: row.name,
        viewThreshold: row.viewThreshold,
        isClippableFormat: row.isClippableFormat,
        brand: row.brand,
        requiredSourcePostType: null,
      });
      targetFormatsByAccount.set(row.sourceAccountId, arr);
    }
    for (const row of derivativeRows) {
      const arr = targetFormatsByAccount.get(row.sourceAccountId) ?? [];
      arr.push({
        id: row.id,
        name: row.name,
        viewThreshold: row.viewThreshold,
        isClippableFormat: row.isClippableFormat,
        brand: row.brand,
        requiredSourcePostType: row.requiredSourcePostType ?? null,
      });
      targetFormatsByAccount.set(row.sourceAccountId, arr);
    }

    // 3. Get existing triggers for dedup.
    //    Key: (pillarId, targetFormatId) — covers both old-model rows
    //    (sourceFormatId set) and new rows (sourceFormatId null).
    const existingTriggers = await db
      .select({
        productionItemId: repurposeTriggers.productionItemId,
        targetFormatId: repurposeTriggers.targetFormatId,
      })
      .from(repurposeTriggers);

    const triggerSet = new Set(
      existingTriggers.map(
        (t) => `${t.productionItemId}|${t.targetFormatId}`
      )
    );

    // 4. Check each item against its source account's configured target formats.
    for (const item of publishedItems) {
      if (!item.accountId || !item.views) continue;

      const targetFormats = targetFormatsByAccount.get(item.accountId) ?? [];

      for (const targetFormat of targetFormats) {
        // Clippable formats are produced exclusively from the Clip Ideas
        // queue (one clip-idea agent run per is_clippable_format row), not
        // from the threshold/repurpose sweep. Skip them here so a pillar
        // crossing a clippable target's viewThreshold doesn't double-create
        // a repurposed Idea alongside the clip-idea-promoted Reel/Short.
        if (targetFormat.isClippableFormat) continue;

        // Derivative formats carry a requiredSourcePostType from the parent's
        // format_channels. Root formats carry null (no constraint). Skip items
        // that don't match the required post_type.
        if (
          targetFormat.requiredSourcePostType &&
          item.postType !== targetFormat.requiredSourcePostType
        ) {
          helpers.logger.debug(
            `threshold-monitor-sweep skip item=${item.id} format=${targetFormat.name} ` +
              `reason=post-type-mismatch required=${targetFormat.requiredSourcePostType} got=${item.postType ?? "null"}`,
          );
          continue;
        }

        // Skip if no threshold set or views below threshold.
        if (!targetFormat.viewThreshold || item.views < targetFormat.viewThreshold) {
          continue;
        }

        // Dedup: one trigger per (pillar, target format) pair.
        const dedupKey = `${item.id}|${targetFormat.id}`;
        if (triggerSet.has(dedupKey)) {
          skippedDuplicate++;
          continue;
        }

        try {
          const editorUserId = await resolveEditor({
            brand: item.brand,
            sourceItemId: item.id,
            format: targetFormat.name,
          });

          // Look up the destination account and post_type for this target
          // format. A format can have multiple channels; pick the
          // oldest-added one deterministically so the assigned account
          // doesn't flip between sweep runs.
          const [formatChannel] = await db
            .select({
              accountId: formatChannels.accountId,
              postType: formatChannels.postType,
            })
            .from(formatChannels)
            .where(eq(formatChannels.formatId, targetFormat.id))
            .orderBy(asc(formatChannels.createdAt), asc(formatChannels.id))
            .limit(1);

          const repurposedTitle = `${targetFormat.name}: ${item.title}`;

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
              postType: formatChannel?.postType ?? null,
              editorUserId,
              utmCampaign: await generateUtmCampaign(item.title),
              createdVia: "cron:threshold-monitor-sweep",
            })
            .returning({ id: productionItems.id });

          if (created) {
            try {
              await recordItemCreated(db, {
                itemId: created.id,
                source: "cron:threshold-monitor-sweep",
                actorUserId: null,
                format: targetFormat.name,
                sourceType: "repurposed",
                postType: formatChannel?.postType ?? null,
              });
            } catch (err) {
              console.error(
                "[cron:threshold-monitor-sweep] recordItemCreated failed",
                err,
              );
            }

            // Record the trigger for dedup. sourceFormatId is null under
            // the new account-based routing model — dedup uses
            // (productionItemId, targetFormatId) only.
            await db.insert(repurposeTriggers).values({
              productionItemId: item.id,
              sourceFormatId: null,
              targetFormatId: targetFormat.id,
              viewsAtTrigger: item.views,
            });

            // Fire the Draft Algorithm so the editor lands on a populated
            // form. Skips internally if the inherited postType isn't in the
            // V1 supported set, or if the pillar has no transcript yet.
            try {
              await enqueue("draft-algorithm-run", {
                productionItemId: created.id,
              });
            } catch (err) {
              helpers.logger.error(
                `draft-algorithm-run enqueue (threshold-sweep) failed for ${created.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }

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
