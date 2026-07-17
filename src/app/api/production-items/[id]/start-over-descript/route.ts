import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  formatChannels,
  formats,
  productionItems,
  repurposeTriggers,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { formatNameToSlug } from "@/lib/db/formats";
import { findAccountForBrandPlatform } from "@/lib/db/accounts";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Wipe all Descript state for a stuck clip-idea production item and put
 * the clip idea back in the queue as a fresh "Idea" row, ready to be
 * re-promoted. Surfaced as the "Start Over" button in the Descript status
 * pill when a job has errored.
 *
 * What this does:
 *   1. Deletes all queue jobs (precise-cut, resolve, publish-and-archive)
 *      for this item so no stale task keeps retrying.
 *   2. Clears Descript fields on the repurpose_trigger.
 *   3. Deletes the stuck production_item row (the generate pipeline creates
 *      one "Idea" row per clip idea and the promote flow upgrades it in-place
 *      to "Assigned" — deleting it removes the stuck state entirely).
 *   4. Re-inserts a fresh "Idea" row for the same clip idea (same fields,
 *      new id) so it immediately reappears in the queue at
 *      /{brand}/queue/{formatSlug}.
 *   5. Increments clip_ideas.descript_attempts so editors see "Attempted:
 *      Nx" on the triage card and know the idea has been tried before.
 *   6. Returns { clipIdeaId, formatSlug } so the UI can redirect.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;
  const { id } = await context.params;
  try {
    return await runStartOver(id, actorUserId);
  } catch (err) {
    console.error("[start-over-descript] unhandled", err);
    return NextResponse.json(
      {
        error: `Start Over failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}

async function runStartOver(id: string, actorUserId: string) {
  const [item] = await db
    .select({
      id: productionItems.id,
      sourceClipIdeaId: productionItems.sourceClipIdeaId,
      format: productionItems.format,
      brand: productionItems.brand,
      pillarContentItemId: productionItems.pillarContentItemId,
      platform: productionItems.platform,
      postType: productionItems.postType,
      accountId: productionItems.accountId,
      hook: productionItems.hook,
      title: productionItems.title,
      contentBody: productionItems.contentBody,
      utmCampaign: productionItems.utmCampaign,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!item.sourceClipIdeaId) {
    return NextResponse.json(
      { error: "This item was not promoted from a clip idea — nothing to start over." },
      { status: 400 },
    );
  }

  // Look up fresh platform/postType/accountId from the format configuration —
  // the stuck item may have stale or incorrect values from when it was first
  // generated, so we always derive from the current format settings.
  let freshPlatform: string[] | undefined;
  let freshPostType: string | undefined;
  let freshAccountId: string | undefined;
  if (item.format) {
    const [fmt] = await db
      .select({
        id: formats.id,
        clipTargetPlatform: formats.clipTargetPlatform,
        clipTargetPostType: formats.clipTargetPostType,
      })
      .from(formats)
      .where(and(eq(formats.name, item.format), eq(formats.brand, item.brand)))
      .limit(1);
    if (fmt) {
      freshPostType = (fmt.clipTargetPostType as string | null) ?? undefined;
      freshPlatform =
        fmt.clipTargetPlatform &&
        Array.isArray(fmt.clipTargetPlatform) &&
        (fmt.clipTargetPlatform as string[]).length > 0
          ? (fmt.clipTargetPlatform as string[])
          : undefined;
      if (freshPostType) {
        const [fcRow] = await db
          .select({ accountId: formatChannels.accountId })
          .from(formatChannels)
          .where(
            and(
              eq(formatChannels.formatId, fmt.id),
              eq(formatChannels.postType, freshPostType),
            ),
          )
          .limit(1);
        if (fcRow) {
          freshAccountId = fcRow.accountId;
        } else {
          const platformKeyMap: Record<string, string> = {
            instagram_reel: "instagram",
            instagram_post: "instagram",
            youtube_long: "youtube",
            youtube_short: "youtube",
            x: "x",
            tiktok: "tiktok",
            linkedin: "linkedin",
            threads: "threads",
          };
          const platformKey = platformKeyMap[freshPostType];
          if (platformKey) {
            const acc = await findAccountForBrandPlatform({
              brandSlug: item.brand,
              platform: platformKey,
            });
            freshAccountId = acc?.id ?? undefined;
          }
        }
      }
    }
  }

  // Find the triggerId from any queue job for this derivative, so we can
  // clear its Descript state below.
  const jobWithTrigger = (await db.execute(sql`
    SELECT payload->>'triggerId' AS trigger_id
    FROM graphile_worker._private_jobs
    WHERE payload->>'derivativeItemId' = ${id}
      AND payload->>'triggerId' IS NOT NULL
    LIMIT 1
  `)) as unknown as Array<{ trigger_id: string | null }>;
  const triggerId = jobWithTrigger[0]?.trigger_id ?? null;

  // Look up task ids once.
  const taskRows = (await db.execute(sql`
    SELECT id, identifier FROM graphile_worker._private_tasks
    WHERE identifier IN (
      'clip-idea-precise-cut',
      'descript-clip-resolve',
      'descript-publish-and-archive'
    )
  `)) as unknown as Array<{ id: number; identifier: string }>;
  const taskIds = taskRows.map((r) => r.id);

  // 1. Delete all queue jobs for this derivative.
  if (taskIds.length) {
    await db.execute(sql`
      DELETE FROM graphile_worker._private_jobs
      WHERE task_id = ANY(ARRAY[${sql.raw(taskIds.join(","))}]::int[])
        AND (
          payload->>'derivativeItemId' = ${id}
          OR payload->>'productionItemId' = ${id}
        )
    `);
  }

  // 2. Clear Descript state on the trigger so the next promotion doesn't
  //    inherit a stale jobId or compositionId.
  if (triggerId) {
    await db
      .update(repurposeTriggers)
      .set({
        descriptJobId: null,
        descriptCompositionId: null,
        descriptProjectUrl: null,
      })
      .where(eq(repurposeTriggers.id, triggerId));
  }

  // 3. Delete the stuck row. The generate pipeline creates one "Idea" row
  //    per clip idea; the promote flow upgrades it to "Assigned" in place.
  //    Deleting it clears all stale Descript state and frees the
  //    clip_ideas.accepted_production_item_id FK (onDelete: set null).
  await db.delete(productionItems).where(eq(productionItems.id, id));

  // 4. Re-insert a fresh "Idea" row with the same fields so the clip idea
  //    immediately reappears in /{brand}/queue/{formatSlug}. The editor
  //    can open the ClipTriageDialog and re-promote it from there.
  const [freshItem] = await db
    .insert(productionItems)
    .values({
      title: item.title ?? item.hook ?? "",
      status: "Idea",
      platform: freshPlatform ?? (item.platform ?? undefined),
      postType: freshPostType ?? (item.postType ?? undefined),
      accountId: freshAccountId ?? (item.accountId ?? undefined),
      format: item.format ?? undefined,
      brand: item.brand,
      contentBody: item.contentBody ?? undefined,
      pillarContentItemId: item.pillarContentItemId ?? undefined,
      sourceType: "repurposed",
      sourceClipIdeaId: item.sourceClipIdeaId,
      editorUserId: actorUserId,
      utmCampaign: item.utmCampaign ?? undefined,
      hook: item.hook ?? undefined,
      hookSource: "clip_idea",
      hookExtractedAt: new Date(),
      createdVia: "service:start-over-descript",
    })
    .returning({ id: productionItems.id });

  if (!freshItem) {
    throw new Error("Failed to re-create production item after start-over");
  }

  // 5. Increment the attempt counter, reset status to "suggested" so it can
  //    be re-promoted, and point acceptedProductionItemId at the fresh row.
  await db
    .update(clipIdeas)
    .set({
      descriptAttempts: sql`${clipIdeas.descriptAttempts} + 1`,
      status: "suggested",
      acceptedProductionItemId: freshItem.id,
    })
    .where(eq(clipIdeas.id, item.sourceClipIdeaId));

  const formatSlug = item.format ? formatNameToSlug(item.format) : null;

  return NextResponse.json({
    ok: true,
    clipIdeaId: item.sourceClipIdeaId,
    formatSlug,
  });
}
