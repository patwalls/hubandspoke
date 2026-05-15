import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { formats, productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  duplicateDescriptComposition,
  invokeDescriptAgent,
} from "@/lib/descript";
import { extractCrossPostRulesSection } from "@/lib/format-skill";
import { buildCompositionName } from "@/lib/services/descript-composition";
import {
  coldImportPillar,
  hasDescriptableMedia,
  loadPillarForSource,
} from "@/lib/services/descript-derivative";
import { enqueue } from "@/jobs/enqueue";

export interface DescriptDerivativeCreatePayload {
  derivativeItemId: string;
  sourceItemId: string;
  /** Set on re-enqueue after a cold-import to give the resolver time to
   *  stamp the pillar's `descript_seed_composition_id`. */
  attempt?: number;
}

const DERIVATIVE_COPY_PATH = "derivative-copy";
const COLD_IMPORT_DELAY_SECONDS = 60;
const MAX_ATTEMPTS = 10;

/**
 * Creates a unique Descript composition for a cross-post / repost
 * derivative. Decision tree:
 *
 *   1. Source itself has a composition → duplicate from it directly.
 *   2. Source's pillar has a project + seed composition → duplicate from
 *      the pillar's seed (warm path).
 *   3. Source's pillar has only mediaS3Key → cold-import the pillar, then
 *      re-enqueue ourselves; on the next pass the pillar's seed is set and
 *      we fall into case 2.
 *
 * Hard-fails if `hasDescriptableMedia(source)` is false — the route layer
 * is supposed to reject those requests before they enqueue this task.
 *
 * Idempotency: if a `repurpose_triggers` row already exists for this
 * derivative with descript_import_path='derivative-copy', returns early so
 * repeated runs don't pile up duplicate Descript jobs.
 */
export const descriptDerivativeCreateTask: Task = async (
  rawPayload,
  helpers,
) => {
  const payload = rawPayload as DescriptDerivativeCreatePayload;
  const attempt = payload.attempt ?? 0;

  if (attempt >= MAX_ATTEMPTS) {
    throw new Error(
      `descript-derivative-create exceeded ${MAX_ATTEMPTS} attempts for derivative=${payload.derivativeItemId}; pillar cold-import never produced a seed composition`,
    );
  }

  const [existingTrigger] = await db
    .select({ id: repurposeTriggers.id })
    .from(repurposeTriggers)
    .where(
      and(
        eq(repurposeTriggers.productionItemId, payload.derivativeItemId),
        eq(repurposeTriggers.descriptImportPath, DERIVATIVE_COPY_PATH),
      ),
    )
    .limit(1);
  if (existingTrigger) {
    helpers.logger.info(
      `descript-derivative-create noop: derivative=${payload.derivativeItemId} already has a derivative-copy trigger=${existingTrigger.id}`,
    );
    return;
  }

  const [derivative] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      postType: productionItems.postType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, payload.derivativeItemId))
    .limit(1);
  if (!derivative) {
    throw new Error(
      `descript-derivative-create: derivative ${payload.derivativeItemId} not found`,
    );
  }

  const [source] = await db
    .select({
      id: productionItems.id,
      brand: productionItems.brand,
      format: productionItems.format,
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      descriptCompositionId: productionItems.descriptCompositionId,
      mediaS3Key: productionItems.mediaS3Key,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, payload.sourceItemId))
    .limit(1);
  if (!source) {
    throw new Error(
      `descript-derivative-create: source ${payload.sourceItemId} not found`,
    );
  }

  // Look up the source format's Cross Post Rules section, if any. Skill is
  // (brand, name)-scoped in the formats table. When the section is present,
  // we send a custom Underlord prompt that re-frames the duplicate for the
  // target platform; when missing, we fall through to a vanilla
  // byte-identical duplicate.
  let crossPostRules: string | null = null;
  if (source.format) {
    const [fmt] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(
        and(
          eq(formats.brand, source.brand),
          eq(formats.name, source.format),
        ),
      )
      .limit(1);
    if (fmt?.instructions) {
      crossPostRules = extractCrossPostRulesSection(fmt.instructions);
    }
  }

  const pillar = await loadPillarForSource(source);
  if (!hasDescriptableMedia(source, pillar)) {
    throw new Error(
      `descript-derivative-create: source ${source.id} has no Descript-able media; the route should have rejected this before enqueue`,
    );
  }

  // Decide which composition to duplicate FROM.
  let dupProjectId: string;
  let dupSourceCompositionId: string;
  let projectUrl: string | null;

  if (source.descriptProjectId && source.descriptCompositionId) {
    // Case 1: source is itself a derivative with its own composition.
    dupProjectId = source.descriptProjectId;
    dupSourceCompositionId = source.descriptCompositionId;
    projectUrl = source.descriptProjectUrl;
  } else if (
    pillar?.descriptProjectId &&
    pillar.descriptSeedCompositionId
  ) {
    // Case 2: warm path via pillar's seed.
    dupProjectId = pillar.descriptProjectId;
    dupSourceCompositionId = pillar.descriptSeedCompositionId;
    projectUrl = pillar.descriptProjectUrl;
  } else if (pillar?.mediaS3Key) {
    // Case 3: cold-import the pillar, then re-enqueue. The resolver
    // (descript-clip-resolve, importMode=true) will stamp the pillar's
    // seed_composition_id when the import finishes — typically within 1-2
    // minutes for a YouTube-length video.
    const importRes = await coldImportPillar({ pillarId: pillar.id });
    if (importRes.imported) {
      // Insert a placeholder trigger so the resolver has somewhere to write
      // the composition_id. We mark it as 'full-video' (matching the
      // existing cold-import path's trigger shape) — the actual derivative
      // composition is created on the NEXT pass of this task, with its own
      // 'derivative-copy' trigger.
      const [trigger] = await db
        .insert(repurposeTriggers)
        .values({
          productionItemId: pillar.id,
          descriptJobId: importRes.jobId,
          descriptProjectUrl: importRes.projectUrl,
          descriptImportPath: "full-video",
        })
        .returning({ id: repurposeTriggers.id });
      await enqueue("descript-clip-resolve", {
        triggerId: trigger.id,
        jobId: importRes.jobId,
        pillarItemId: pillar.id,
        importMode: true,
      });
    }
    // Re-enqueue ourselves to pick up the seed once cold-import finishes.
    await helpers.addJob(
      "descript-derivative-create",
      { ...payload, attempt: attempt + 1 },
      { runAt: new Date(Date.now() + COLD_IMPORT_DELAY_SECONDS * 1000) },
    );
    helpers.logger.info(
      `descript-derivative-create: cold-importing pillar=${pillar.id}, re-enqueueing derivative=${payload.derivativeItemId} in ${COLD_IMPORT_DELAY_SECONDS}s (attempt=${attempt + 1})`,
    );
    return;
  } else {
    throw new Error(
      `descript-derivative-create: source ${source.id} has no path to a composition (no own composition, no pillar seed, no pillar media)`,
    );
  }

  const newCompositionName = buildCompositionName({
    title: derivative.title,
    productionItemId: derivative.id,
  });

  // When the source format's Skill carries a "### Cross Post Rules"
  // section, send a custom Underlord prompt that duplicates the composition
  // AND applies platform-specific framing for the derivative's postType
  // (e.g. re-aspect 9:16 → 16:9 when cross-posting to Twitter/LinkedIn).
  // Without the section, fall back to the standard byte-identical duplicate.
  let dup: {
    jobId: string;
    projectUrl: string;
    projectId: string;
    prompt: string;
  };
  if (crossPostRules) {
    const safeName = newCompositionName.replace(/"/g, '\\"');
    const targetPostType = derivative.postType ?? "unknown";
    const prompt = [
      `Duplicate the existing composition in this project — the one with compositionId="${dupSourceCompositionId}".`,
      `Name the new composition "${safeName}". Do not modify the source composition.`,
      ``,
      `This duplicate is a CROSS-POST. Target platform / postType: ${targetPostType}.`,
      `Apply the cross-post rules below to the DUPLICATE only — adjust aspect ratio,`,
      `framing, or layout as the rules require. The transcript and media should be`,
      `the same as the source unless a rule says otherwise.`,
      ``,
      `### Cross Post Rules`,
      crossPostRules,
      ``,
      `Reply with the new compositionId in the form compositionId="<uuid>".`,
    ].join("\n");
    const result = await invokeDescriptAgent({
      projectId: dupProjectId,
      prompt,
    });
    dup = { ...result, prompt };
  } else {
    dup = await duplicateDescriptComposition({
      projectId: dupProjectId,
      sourceCompositionId: dupSourceCompositionId,
      newCompositionName,
    });
  }

  // Stamp the derivative with the project info; composition_id arrives via
  // the resolver poller.
  await db
    .update(productionItems)
    .set({
      descriptProjectId: dupProjectId,
      descriptProjectUrl: projectUrl ?? dup.projectUrl ?? null,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, derivative.id));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: derivative.id,
      descriptJobId: dup.jobId,
      descriptProjectUrl: projectUrl ?? dup.projectUrl ?? null,
      descriptPrompt: dup.prompt,
      compositionName: newCompositionName,
      descriptImportPath: DERIVATIVE_COPY_PATH,
    })
    .returning({ id: repurposeTriggers.id });

  await enqueue("descript-clip-resolve", {
    triggerId: trigger.id,
    jobId: dup.jobId,
    derivativeItemId: derivative.id,
    importMode: false,
  });

  helpers.logger.info(
    `descript-derivative-create ok: derivative=${derivative.id} source=${source.id} composition_job=${dup.jobId}`,
  );
};
