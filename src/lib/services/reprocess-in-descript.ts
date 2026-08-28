import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  productionItems,
  repurposeTriggers,
} from "@/lib/db/schema";
import {
  duplicateDescriptComposition,
  invokeDescriptAgent,
} from "@/lib/descript";
import { buildCompositionName } from "@/lib/services/descript-composition";
import { coldImportPillar } from "@/lib/services/descript-derivative";
import { enqueue } from "@/jobs/enqueue";
import { recordToolAction } from "@/lib/services/content-events";
import {
  loadPromotedClipFormat,
  buildDescriptPrompt,
  extractQuotablesFromExtras,
} from "@/lib/services/promote-clip-idea";
import { resolveClipAspectRatio } from "@/lib/db/formats";

export type ReprocessMode = "full" | "precise" | "buffered" | "agent";

export class ReprocessMissingClipIdeaError extends Error {
  constructor() {
    super("This item has no linked clip idea — cannot reprocess.");
    this.name = "ReprocessMissingClipIdeaError";
  }
}
export class ReprocessMissingMediaError extends Error {
  constructor() {
    super("Source pillar has no media file — cannot reprocess.");
    this.name = "ReprocessMissingMediaError";
  }
}
export class ReprocessMissingDescriptProjectError extends Error {
  constructor() {
    super(
      "Source pillar has no Descript project — cannot use Underlord. Try Buffered Cut instead.",
    );
    this.name = "ReprocessMissingDescriptProjectError";
  }
}

const BUFFER_SEC = 60;

export async function reprocessProductionItemInDescript(args: {
  productionItemId: string;
  actorUserId: string;
  mode: ReprocessMode;
}): Promise<void> {
  // 1. Load the derivative production item
  const [derivItem] = await db
    .select({
      id: productionItems.id,
      sourceClipIdeaId: productionItems.sourceClipIdeaId,
      brand: productionItems.brand,
      format: productionItems.format,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.productionItemId))
    .limit(1);

  if (!derivItem?.sourceClipIdeaId) throw new ReprocessMissingClipIdeaError();

  // 2. Load the clip idea for timestamps + hook
  const [clipIdea] = await db
    .select({
      id: clipIdeas.id,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      hook: clipIdeas.hook,
      targetFormat: clipIdeas.targetFormat,
      extras: clipIdeas.extras,
      hookSegments: clipIdeas.hookSegments,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
    })
    .from(clipIdeas)
    .where(eq(clipIdeas.id, derivItem.sourceClipIdeaId))
    .limit(1);

  if (!clipIdea) throw new ReprocessMissingClipIdeaError();

  // 3. Load the pillar for media + existing Descript state
  const [pillar] = await db
    .select({
      id: productionItems.id,
      mediaS3Key: productionItems.mediaS3Key,
      descriptProjectId: productionItems.descriptProjectId,
      descriptSeedCompositionId: productionItems.descriptSeedCompositionId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      descriptAccount: productionItems.descriptAccount,
    })
    .from(productionItems)
    .where(eq(productionItems.id, clipIdea.sourceProductionItemId))
    .limit(1);

  if (!pillar) throw new ReprocessMissingClipIdeaError();

  const startSec = Number(clipIdea.startSec);
  const endSec = Number(clipIdea.endSec);
  const brand = derivItem.brand;

  // 4. For agent/full modes, load the format for prompt building.
  //    For precise/buffered, we only need it for the trigger row's targetFormatId
  //    (optional) — don't block on FormatMissingSkillError.
  let format: Awaited<ReturnType<typeof loadPromotedClipFormat>> | null = null;
  try {
    format = await loadPromotedClipFormat({
      brand,
      targetFormatName: clipIdea.targetFormat ?? derivItem.format ?? null,
    });
  } catch (err) {
    if (args.mode === "agent" || args.mode === "full") throw err;
    // precise/buffered: format is nice-to-have for the trigger row but not required
  }

  // 5. Insert a repurpose_triggers row (audit trail; worker writes
  //    descriptCompositionId back via triggerId)
  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: pillar.id,
      ...(format ? { targetFormatId: format.id } : {}),
      compositionName: buildCompositionName({
        title: clipIdea.hook,
        productionItemId: args.productionItemId,
      }),
      descriptImportPath:
        args.mode === "agent"
          ? "agent"
          : args.mode === "full"
            ? "full-video"
            : "precise-cut",
    })
    .returning({ id: repurposeTriggers.id });

  // 6. Dispatch based on mode. Existing Descript fields on the production
  //    item are NOT cleared here — they stay valid until the worker (or the
  //    synchronous call below) overwrites them on success.
  if (args.mode === "precise" || args.mode === "buffered") {
    const cutStartSec =
      args.mode === "buffered"
        ? Math.max(0, startSec - BUFFER_SEC)
        : undefined;
    const cutEndSec =
      args.mode === "buffered" ? endSec + BUFFER_SEC : undefined;

    await recordToolAction({
      contentItemId: args.productionItemId,
      userId: args.actorUserId,
      tool: "descript",
      action: "kicking_off",
      status: "info",
      label:
        args.mode === "buffered"
          ? "Trimming with 60-second buffer and uploading to Descript… new composition incoming."
          : "Trimming clip locally + uploading to Descript… new composition incoming.",
      meta: {
        importPath: "precise-cut",
        buffered: args.mode === "buffered" ? 1 : 0,
        reprocess: 1,
      },
    });

    await enqueue(
      "clip-idea-precise-cut",
      {
        clipIdeaId: clipIdea.id,
        triggerId: trigger.id,
        derivativeItemId: args.productionItemId,
        // Precise Cut applies the format/skill's layout pack (the worker
        // re-checks the format actually has a skill/pack and skips if not).
        // Buffered Cut is a plain trim with NO Underlord call — its whole
        // purpose is editing room, so it imports as-is (source orientation)
        // and the editor styles it after finalizing the trim. Only
        // precise/buffered reach this branch.
        applyLayoutPack: args.mode === "precise",
        ...(cutStartSec !== undefined ? { cutStartSec } : {}),
        ...(cutEndSec !== undefined ? { cutEndSec } : {}),
      },
      {
        jobKey: `reprocess:${args.productionItemId}`,
        jobKeyMode: "replace",
        queueName: "media-heavy",
      },
    );
    return;
  }

  if (args.mode === "full") {
    // Warm path: pillar already has a Descript project → duplicate composition
    if (pillar.descriptProjectId && pillar.descriptSeedCompositionId) {
      const compositionName = buildCompositionName({
        title: clipIdea.hook,
        productionItemId: args.productionItemId,
      });
      const dup = await duplicateDescriptComposition({
        projectId: pillar.descriptProjectId,
        sourceCompositionId: pillar.descriptSeedCompositionId,
        newCompositionName: compositionName,
        caller: "reprocess-full-video",
        productionItemId: args.productionItemId,
        account: pillar.descriptAccount,
      });
      await db
        .update(productionItems)
        .set({
          descriptProjectId: dup.projectId,
          descriptProjectUrl: pillar.descriptProjectUrl ?? dup.projectUrl ?? null,
          descriptAccount: pillar.descriptAccount,
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, args.productionItemId));

      await recordToolAction({
        contentItemId: args.productionItemId,
        userId: args.actorUserId,
        tool: "descript",
        action: "kicking_off",
        status: "info",
        label: "Duplicating the pillar composition in Descript…",
        url: pillar.descriptProjectUrl ?? undefined,
        meta: { importPath: "full-video", mode: "warm", reprocess: 1 },
      });

      await enqueue("descript-clip-resolve", {
        triggerId: trigger.id,
        jobId: dup.jobId,
        derivativeItemId: args.productionItemId,
      });
      return;
    }

    // Cold path: no Descript project yet → upload the full video
    if (!pillar.mediaS3Key) throw new ReprocessMissingMediaError();

    const importRes = await coldImportPillar({
      pillarId: pillar.id,
      account: "hubspot",
    });
    if (!importRes.imported) {
      throw new Error(
        `Pillar ${pillar.id} was cold-imported concurrently — retry in a moment`,
      );
    }
    await db
      .update(productionItems)
      .set({
        descriptProjectId: importRes.projectId,
        descriptProjectUrl: importRes.projectUrl,
        descriptAccount: "hubspot",
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, args.productionItemId));

    await recordToolAction({
      contentItemId: args.productionItemId,
      userId: args.actorUserId,
      tool: "descript",
      action: "kicking_off",
      status: "info",
      label: "Uploading the full pillar to Descript…",
      meta: { importPath: "full-video", mode: "cold", reprocess: 1 },
    });

    await enqueue("descript-clip-resolve", {
      triggerId: trigger.id,
      jobId: importRes.jobId,
      derivativeItemId: args.productionItemId,
    });
    return;
  }

  if (args.mode === "agent") {
    if (!pillar.descriptProjectId) throw new ReprocessMissingDescriptProjectError();

    // format is guaranteed non-null here (we re-throw on load failure above)
    const aspectRatio = resolveClipAspectRatio({
      clipAspectRatio: format!.clipAspectRatio,
      clipTargetPostType: format!.clipTargetPostType,
    });
    const quotables = extractQuotablesFromExtras(
      clipIdea.extras as Record<string, unknown> | null,
    );
    const prompt = buildDescriptPrompt({
      skill: format!.skill,
      hook: clipIdea.hook,
      startSec,
      endSec,
      productionItemId: args.productionItemId,
      aspectRatio,
      quotables,
    });

    const agent = await invokeDescriptAgent({
      projectId: pillar.descriptProjectId,
      prompt,
      caller: "reprocess-agent",
      productionItemId: args.productionItemId,
      account: pillar.descriptAccount,
    });

    await db
      .update(productionItems)
      .set({
        descriptProjectId: pillar.descriptProjectId,
        descriptProjectUrl: agent.projectUrl,
        descriptAccount: pillar.descriptAccount,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, args.productionItemId));

    await db
      .update(repurposeTriggers)
      .set({
        descriptJobId: agent.jobId,
        descriptProjectUrl: agent.projectUrl,
        descriptPrompt: prompt,
      })
      .where(eq(repurposeTriggers.id, trigger.id));

    await recordToolAction({
      contentItemId: args.productionItemId,
      userId: args.actorUserId,
      tool: "descript",
      action: "kicking_off",
      status: "info",
      label: "Creating clip with Underlord…",
      url: agent.projectUrl,
      meta: { importPath: "agent", reprocess: 1 },
    });

    await enqueue("descript-clip-resolve", {
      triggerId: trigger.id,
      jobId: agent.jobId,
      derivativeItemId: args.productionItemId,
    });
  }
}
