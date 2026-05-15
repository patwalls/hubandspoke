import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { formats, productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  cutSegmentWithRules,
  duplicateDescriptComposition,
  invokeDescriptAgent,
} from "@/lib/descript";
import { extractCrossPostRulesSection } from "@/lib/format-skill";
import { findAnchorInWords } from "@/lib/clip-idea-agent";
import { buildCompositionName } from "@/lib/services/descript-composition";
import {
  coldImportPillar,
  hasDescriptableMedia,
  loadPillarForSource,
  resolveImportTarget,
} from "@/lib/services/descript-derivative";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
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

/** Prefixes used to communicate structured "blocked, needs human action"
 *  states from this task up to the status route. The status route
 *  pattern-matches on `last_error` and emits `status: "blocked"` +
 *  `blockedReason: "<reason>"` to the UI. Kept as exported constants so
 *  the route imports them and there's a single source of truth.
 *
 *  The error throws (rather than silently returning) so graphile-worker
 *  surfaces the failure in `graphile_worker.jobs.last_error` after the
 *  retry budget is exhausted, where the status route can find it. */
export const BLOCKED_ERROR_PREFIX = "blocked:";
export type BlockedReason =
  | "needs_pillar_media"
  | "needs_transcript"
  | "no_segment_match";
function blockedError(reason: BlockedReason, detail: string): Error {
  return new Error(`${BLOCKED_ERROR_PREFIX}${reason}: ${detail}`);
}

/**
 * Creates a unique Descript composition for a cross-post / repost
 * derivative. Decision tree (in order):
 *
 *   1. Source has its own composition → duplicate it (with Cross Post
 *      Rules so Underlord re-aspects for the target platform when needed).
 *      The new composition lives in the source's project, which already
 *      owns the high-res media — re-aspect is safe.
 *
 *   2. Import target (pillar if source is a derivative, source itself if
 *      source IS a pillar) has a Descript project + seed composition.
 *      Find the source's segment in the target's transcript via local
 *      `findAnchorInWords`, then send Underlord a pinned-timestamp cut
 *      prompt (`cutSegmentWithRules`). Strict-refuse with
 *      `blocked:needs_transcript:` if either transcript lacks `words[]`,
 *      or `blocked:no_segment_match:` if the anchor isn't found.
 *
 *   3. Import target has media but no project → cold-import + re-enqueue.
 *      Next pass falls into Case 2 once the seed is stamped.
 *
 *   4. Import target has no media → `blocked:needs_pillar_media:`.
 *
 * Source media is NEVER cold-imported when the source is a derivative —
 * its `mediaS3Key` is a finished export (cropped, low-res) and would
 * produce a lossy re-aspect.
 *
 * Idempotency: if a `repurpose_triggers` row already exists for this
 * derivative with descript_import_path='derivative-copy', returns early
 * so repeated runs don't pile up duplicate Descript jobs.
 */
export const descriptDerivativeCreateTask: Task = async (
  rawPayload,
  helpers,
) => {
  const payload = rawPayload as DescriptDerivativeCreatePayload;
  const attempt = payload.attempt ?? 0;

  if (attempt >= MAX_ATTEMPTS) {
    throw new Error(
      `descript-derivative-create exceeded ${MAX_ATTEMPTS} attempts for derivative=${payload.derivativeItemId}; cold-import never produced a seed composition`,
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
      descriptSeedCompositionId: productionItems.descriptSeedCompositionId,
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

  // Source format's Cross Post Rules section (target aspect, caption
  // shape, etc.). Same section is shared with the Draft Algorithm. When
  // absent, the duplicate / cut runs without rules — Underlord just
  // produces a byte-identical or range-identical composition.
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
    throw blockedError(
      "needs_pillar_media",
      `source ${source.id} has no Descript-able media (no own composition; import target has no project/seed and no media)`,
    );
  }

  const newCompositionName = buildCompositionName({
    title: derivative.title,
    productionItemId: derivative.id,
  });
  const targetPostType = derivative.postType ?? "unknown";

  // CASE 1 — Source has its own composition. Duplicate it in-place
  // (re-aspect is safe; the new comp lives in the source's project with
  // its high-res media). Cross Post Rules drive any framing changes.
  if (source.descriptProjectId && source.descriptCompositionId) {
    const dup = await invokeRulesAwareDuplicate({
      projectId: source.descriptProjectId,
      sourceCompositionId: source.descriptCompositionId,
      newCompositionName,
      crossPostRules,
      targetPostType,
    });
    await finishStamp({
      derivativeId: derivative.id,
      dupProjectId: source.descriptProjectId,
      projectUrl: source.descriptProjectUrl ?? dup.projectUrl ?? null,
      dup,
      newCompositionName,
    });
    helpers.logger.info(
      `descript-derivative-create ok (case 1: source-composition): derivative=${derivative.id} source=${source.id} composition_job=${dup.jobId}`,
    );
    return;
  }

  // CASE 2 — Import target has project + seed: transcript-anchored cut.
  const target = resolveImportTarget(source, pillar);
  if (!target) {
    throw blockedError(
      "needs_pillar_media",
      `source ${source.id} has an upstream pillar=${source.pillarContentItemId} but it didn't load`,
    );
  }

  if (target.row.descriptProjectId && target.row.descriptSeedCompositionId) {
    const sourceTranscript = await getTranscriptForPrompt(source.id);
    if (!sourceTranscript || sourceTranscript.words.length === 0) {
      throw blockedError(
        "needs_transcript",
        `source ${source.id} has no Whisper transcript with word-level timestamps; can't anchor segment in pillar`,
      );
    }
    // When source-is-pillar, target.row.id === source.id — no need to
    // re-query, the transcript we just loaded IS the target's transcript.
    const targetTranscript =
      target.row.id === source.id
        ? sourceTranscript
        : await getTranscriptForPrompt(target.row.id);
    if (!targetTranscript || targetTranscript.words.length === 0) {
      throw blockedError(
        "needs_transcript",
        `import target ${target.row.id} (${target.kind}) has no Whisper transcript with word-level timestamps`,
      );
    }
    const anchor = findAnchorInWords(
      sourceTranscript.fullText,
      targetTranscript.words,
    );
    if (!anchor) {
      throw blockedError(
        "no_segment_match",
        `source ${source.id}'s spoken content not found in target ${target.row.id}'s transcript — pillar may be wrong`,
      );
    }
    const dup = await cutSegmentWithRules({
      projectId: target.row.descriptProjectId,
      newCompositionName,
      startSec: anchor.startSec,
      endSec: anchor.endSec,
      crossPostRules,
      targetPostType,
    });
    await finishStamp({
      derivativeId: derivative.id,
      dupProjectId: target.row.descriptProjectId,
      projectUrl: target.row.descriptProjectUrl ?? dup.projectUrl ?? null,
      dup,
      newCompositionName,
    });
    helpers.logger.info(
      `descript-derivative-create ok (case 2: target-cut): derivative=${derivative.id} target=${target.row.id} (${target.kind}) range=[${anchor.startSec.toFixed(1)},${anchor.endSec.toFixed(1)}]s job=${dup.jobId}`,
    );
    return;
  }

  // CASE 3 — Import target has media but no project. Cold-import + re-enqueue.
  if (target.row.mediaS3Key) {
    const importRes = await coldImportPillar({ pillarId: target.row.id });
    if (importRes.imported) {
      const [trigger] = await db
        .insert(repurposeTriggers)
        .values({
          productionItemId: target.row.id,
          descriptJobId: importRes.jobId,
          descriptProjectUrl: importRes.projectUrl,
          descriptImportPath: "full-video",
        })
        .returning({ id: repurposeTriggers.id });
      await enqueue("descript-clip-resolve", {
        triggerId: trigger.id,
        jobId: importRes.jobId,
        pillarItemId: target.row.id,
        importMode: true,
      });
    }
    await helpers.addJob(
      "descript-derivative-create",
      { ...payload, attempt: attempt + 1 },
      { runAt: new Date(Date.now() + COLD_IMPORT_DELAY_SECONDS * 1000) },
    );
    helpers.logger.info(
      `descript-derivative-create cold-import: target=${target.row.id} (${target.kind}), re-enqueueing derivative=${payload.derivativeItemId} in ${COLD_IMPORT_DELAY_SECONDS}s (attempt=${attempt + 1})`,
    );
    return;
  }

  // CASE 4 — No path. (Should be caught by hasDescriptableMedia above; this
  // is defense in depth.)
  throw blockedError(
    "needs_pillar_media",
    `import target ${target.row.id} (${target.kind}) has no project, no seed, no media`,
  );
};

/** Wraps the Underlord duplicate call with Cross Post Rules when present
 *  (Underlord re-aspects per the rules), or falls back to the byte-
 *  identical duplicate helper when no rules apply. */
async function invokeRulesAwareDuplicate(args: {
  projectId: string;
  sourceCompositionId: string;
  newCompositionName: string;
  crossPostRules: string | null;
  targetPostType: string;
}): Promise<{
  jobId: string;
  projectUrl: string;
  projectId: string;
  prompt: string;
}> {
  if (!args.crossPostRules) {
    return duplicateDescriptComposition({
      projectId: args.projectId,
      sourceCompositionId: args.sourceCompositionId,
      newCompositionName: args.newCompositionName,
    });
  }
  const safeName = args.newCompositionName.replace(/"/g, '\\"');
  const prompt = [
    `Duplicate the existing composition in this project — the one with compositionId="${args.sourceCompositionId}".`,
    `Name the new composition "${safeName}". Do not modify the source composition.`,
    ``,
    `This duplicate is a CROSS-POST. Target platform / postType: ${args.targetPostType}.`,
    `Apply the cross-post rules below to the DUPLICATE only — adjust aspect ratio,`,
    `framing, or layout as the rules require. The transcript and media should be`,
    `the same as the source unless a rule says otherwise. Bullets about caption shape`,
    `are for a separate pipeline and you can ignore them.`,
    ``,
    `### Cross Post Rules`,
    args.crossPostRules,
    ``,
    `Reply with the new compositionId in the form compositionId="<uuid>".`,
  ].join("\n");
  const result = await invokeDescriptAgent({
    projectId: args.projectId,
    prompt,
  });
  return { ...result, prompt };
}

/** Shared stamp / trigger / resolver-enqueue block used by cases 1 and 2.
 *  Writes project IDs onto the derivative, inserts a derivative-copy
 *  repurpose_triggers row, and enqueues descript-clip-resolve to stamp
 *  the new composition_id once Underlord finishes. */
async function finishStamp(args: {
  derivativeId: string;
  dupProjectId: string;
  projectUrl: string | null;
  dup: { jobId: string; projectUrl: string; prompt: string };
  newCompositionName: string;
}): Promise<void> {
  await db
    .update(productionItems)
    .set({
      descriptProjectId: args.dupProjectId,
      descriptProjectUrl: args.projectUrl ?? args.dup.projectUrl ?? null,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, args.derivativeId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: args.derivativeId,
      descriptJobId: args.dup.jobId,
      descriptProjectUrl: args.projectUrl ?? args.dup.projectUrl ?? null,
      descriptPrompt: args.dup.prompt,
      compositionName: args.newCompositionName,
      descriptImportPath: DERIVATIVE_COPY_PATH,
    })
    .returning({ id: repurposeTriggers.id });

  await enqueue("descript-clip-resolve", {
    triggerId: trigger.id,
    jobId: args.dup.jobId,
    derivativeItemId: args.derivativeId,
    importMode: false,
  });
}
