/**
 * The design editor's entry from the Repurposed (SPOKE) queue, whose rows are
 * pillar × format CANDIDATES, not items. A design needs an item to live on,
 * so opening the designer on a candidate creates the derivative item the
 * classic "Assign editor" would (same fields, same activity records) — or
 * reuses the one an earlier open created, so re-opening a candidate lands on
 * the same draft.
 *
 * Deliberately does NOT fire `canva-create-copy` (this editor is what that
 * job is being replaced by) and marks the item `createdVia: "design-editor"`
 * so it's distinguishable from a manual repurpose.
 */
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, productionItems, repurposeTriggers } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { requestAutoFrames } from "./frames";
import { getChannelsForFormats, pickBestAccountForFormat } from "@/lib/format-channels";
import { recordItemCreated } from "@/lib/services/item-created";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { loadFormatTemplate } from "./format-template";

export class DesignItemCreateError extends Error {
  constructor(message: string, public readonly status: 400 | 404) {
    super(message);
    this.name = "DesignItemCreateError";
  }
}

export async function findOrCreateDesignItem(args: {
  pillarId: string;
  targetFormatId: string;
  actorUserId: string;
}): Promise<{ productionItemId: string; created: boolean }> {
  const [source] = await db.select().from(productionItems).where(eq(productionItems.id, args.pillarId)).limit(1);
  if (!source) throw new DesignItemCreateError("Source item not found", 404);
  const [target] = await db.select().from(formats).where(eq(formats.id, args.targetFormatId)).limit(1);
  if (!target) throw new DesignItemCreateError("Target format not found", 404);
  if (target.brand !== source.brand) throw new DesignItemCreateError("Target format must belong to the same brand", 400);
  if (!(await loadFormatTemplate(target.brand, target.name))) throw new DesignItemCreateError("This format has no design template", 400);

  const [existing] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.pillarContentItemId, source.id),
        eq(productionItems.format, target.name),
        eq(productionItems.createdVia, "design-editor"),
        notInArray(productionItems.status, ["Published", "Killed"]),
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(productionItems.createdAt)
    .limit(1);
  if (existing) return { productionItemId: existing.id, created: false };

  const channelMap = await getChannelsForFormats([target.id]);
  const firstChannel = channelMap.get(target.id)?.[0] ?? null;
  const bestAccount = await pickBestAccountForFormat({
    brand: source.brand,
    format: target.name,
    postType: firstChannel?.postType ?? null,
  });
  const formatCheck = await normalizeFormatForWrite(source.brand, target.name);
  const canonicalFormat = formatCheck.ok ? formatCheck.value : target.name;

  const [created] = await db
    .insert(productionItems)
    .values({
      brand: source.brand,
      title: source.title,
      thumbnail: source.thumbnail,
      status: "Assigned",
      accountId: bestAccount?.accountId ?? firstChannel?.accountId ?? null,
      postType: firstChannel?.postType ?? null,
      format: canonicalFormat,
      sourceType: "repurposed",
      pillarContentNotionId: source.notionId,
      pillarContentItemId: source.id,
      utmCampaign: await generateUtmCampaign(source.title),
      editorUserId: args.actorUserId,
      createdVia: "design-editor",
    })
    .returning({ id: productionItems.id });

  try {
    await recordItemCreated(db, {
      itemId: created.id,
      source: "design-editor",
      actorUserId: args.actorUserId,
      format: canonicalFormat,
      sourceType: "repurposed",
      postType: firstChannel?.postType ?? null,
    });
  } catch (err) {
    console.error("[design-editor] recordItemCreated failed", err);
  }
  // Same dedup marker the manual repurpose leaves, so threshold-monitor-sweep
  // doesn't auto-create a second derivative for this pair.
  await db.insert(repurposeTriggers).values({ productionItemId: source.id, targetFormatId: target.id, compositionName: target.name });
  // The Draft Algorithm fills the post's form fields (caption etc.).
  try {
    await enqueue("draft-algorithm-run", { productionItemId: created.id });
  } catch (err) {
    console.error("draft-algorithm-run enqueue (design-editor) failed:", err);
  }
  // Start pulling cover-photo frames now, so they're ready when the editor
  // opens (the AI brief takes ~17s on the web side).
  await requestAutoFrames(created.id, source.id).catch((err) => console.error("design-frames enqueue (design-editor) failed:", err));
  return { productionItemId: created.id, created: true };
}
