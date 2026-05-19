import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  buildDescriptCompositionUrl,
  fetchDescriptJob,
  extractCompositionIdFromAgentResponse,
} from "@/lib/descript";
import { assertCompositionUnique } from "@/lib/services/descript-composition";
import { recordToolAction } from "@/lib/services/content-events";

export interface DescriptClipResolvePayload {
  triggerId: string;
  jobId: string;
  derivativeItemId?: string;
  /** Set on the cold full-video path: when the import finishes, stamp the
   *  source-composition id back on the pillar so subsequent clips use the
   *  warm duplicate path. */
  pillarItemId?: string;
  /** True for `import/project_media` jobs (cold full-video upload); false /
   *  unset for `agent` jobs (composition duplicate or AI clip). Switches how
   *  we parse the new compositionId from the job result. */
  importMode?: boolean;
  /** Set by the Draft Algorithm's cold-import path
   *  (`runDescriptStepForDerivative` in
   *  `src/lib/services/draft-algorithm/descript-step.ts`). When the import
   *  job stops, we invoke Underlord against the now-warm project with this
   *  prompt instead of writing the imported composition straight onto the
   *  derivative. Carries the full Skill-built prompt so the resolver doesn't
   *  need to re-derive it from the trigger / format Skill across queue
   *  serialization. */
  postImportAgentPrompt?: string;
  /** Epoch ms. Set on the first invocation; carried forward across re-enqueues. */
  deadlineAt?: number;
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 10 * 60 * 1000;

/**
 * Do one poll of a Descript job. If stopped, write the new compositionId.
 * If not, self-re-enqueue with a 5s delay. Keeping each invocation <1s means
 * SIGTERM during a deploy never catches us mid-poll, so the job's lock never
 * leaks.
 *
 * Handles two job shapes:
 *   - Agent jobs (default): compositionId lives in `result.agent_response`.
 *     Used by the AI clip path AND the warm full-video duplicate path.
 *   - Import jobs (importMode=true): compositionId lives in
 *     `result.created_compositions[0].id`. Used by the cold full-video
 *     upload — first clip on a pillar that has no Descript project yet.
 */
export const descriptClipResolveTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DescriptClipResolvePayload;
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  const job = await fetchDescriptJob(payload.jobId);
  if (job.job_state === "stopped") {
    // Descript reports failures as stopped + result.status="error". Without
    // this guard the poller would write a NULL composition_id (or none for
    // pre-existing rows) and silently exit, leaving the UI stuck on "Clip
    // processing…". Throw so graphile-worker retries and surfaces the
    // failure in last_error after exhaustion.
    if (job.result?.status === "error") {
      throw new Error(
        `Descript ${payload.importMode ? "import" : "agent"} job ${payload.jobId} failed: ${job.result.error_message ?? "no error message"}`,
      );
    }
    // Auto-detect import vs agent when the caller didn't specify (the
    // redrive endpoint omits importMode for "full-video" triggers since
    // that path can be either cold-import or warm-duplicate). Import
    // jobs always populate `created_compositions`; agent jobs put the
    // composition id inside `agent_response`.
    const importMode =
      payload.importMode ?? Boolean(job.result?.created_compositions?.length);
    const compositionId = importMode
      ? job.result?.created_compositions?.[0]?.id ?? null
      : extractCompositionIdFromAgentResponse(job.result?.agent_response);

    // Cold-import + chained-agent path (Draft Algorithm V1.7 cold branch).
    // The import has produced the pillar's seed composition; instead of
    // stamping the derivative with it, we now invoke Underlord against the
    // freshly-warm project to produce the Skill-driven cut. The same
    // trigger row gets repointed at the agent jobId; the resolver re-enters
    // with no `importMode` + no `postImportAgentPrompt` and the existing
    // non-import branch below writes the derivative composition + chains
    // publish-and-archive on the *next* stop.
    if (importMode && payload.postImportAgentPrompt && compositionId) {
      // 2026-05-18: Underlord auto-fire kill switch. This branch fires
      // Underlord automatically after a cold-import completes — it was
      // the second half of the Draft Algorithm's Descript step. With the
      // Descript step itself disabled in descript-step.ts, no live caller
      // sets `postImportAgentPrompt` anymore, but the safety net belongs
      // here too in case a stale in-queue job still carries one. Log +
      // stamp the seed (so the pillar isn't wasted) and exit; the Underlord
      // call does not happen.
      if (payload.pillarItemId) {
        await db
          .update(productionItems)
          .set({ descriptSeedCompositionId: compositionId })
          .where(eq(productionItems.id, payload.pillarItemId));
      }
      helpers.logger.info(
        `descript-clip-resolve cold-chain skipped post-import agent (Underlord auto-fire disabled) trigger=${payload.triggerId} pillar=${payload.pillarItemId} seed=${compositionId}`,
      );
      return;
    }

    await db
      .update(repurposeTriggers)
      .set({ descriptCompositionId: compositionId })
      .where(eq(repurposeTriggers.id, payload.triggerId));
    if (payload.derivativeItemId && compositionId) {
      await assertCompositionUnique({
        compositionId,
        intendedItemId: payload.derivativeItemId,
      });
      await db
        .update(productionItems)
        .set({ descriptCompositionId: compositionId })
        .where(eq(productionItems.id, payload.derivativeItemId));

      // Surface the completion in the activity feed. Read editor +
      // project_id off the just-updated derivative; both are set during
      // promotion (editorUserId by resolveAssignees, descriptProjectId
      // by the agent/full-video path before this poller fires).
      const [derivative] = await db
        .select({
          editorUserId: productionItems.editorUserId,
          descriptProjectId: productionItems.descriptProjectId,
        })
        .from(productionItems)
        .where(eq(productionItems.id, payload.derivativeItemId))
        .limit(1);
      const compositionUrl = derivative?.descriptProjectId
        ? buildDescriptCompositionUrl(
            derivative.descriptProjectId,
            compositionId,
          )
        : null;
      await recordToolAction({
        contentItemId: payload.derivativeItemId,
        userId: derivative?.editorUserId ?? null,
        tool: "descript",
        action: "clip_created",
        status: "success",
        label: "Clip ready in Descript",
        url: compositionUrl,
        meta: { importPath: importMode ? "import" : "agent" },
      });

      // Auto-chain: kick off the publish-and-archive task so the
      // derivative ends up with a rendered MP4 in our S3 bucket and the
      // simulator on its detail page can render it. The task is
      // idempotent (no-op if descript_published_at is already set), so
      // double-firing is harmless.
      await helpers.addJob("descript-publish-and-archive", {
        productionItemId: payload.derivativeItemId,
      });
    }
    // Cold full-video import: stamp the pillar's seed_composition_id (NOT
    // its composition_id) so the next clip on this pillar takes the warm
    // (duplicate) path. Pillars never own a composition — that belongs to
    // derivatives. The DB has a unique partial index on
    // descript_composition_id; writing it to the pillar here would collide
    // with the derivative we just stamped above.
    if (payload.pillarItemId && importMode && compositionId) {
      await db
        .update(productionItems)
        .set({ descriptSeedCompositionId: compositionId })
        .where(eq(productionItems.id, payload.pillarItemId));
    }
    helpers.logger.info(
      `descript-clip-resolve ok trigger=${payload.triggerId} composition=${compositionId ?? "none"}${importMode ? " (import)" : ""}`,
    );
    return;
  }

  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Descript job ${payload.jobId} did not stop before deadline`,
    );
  }

  await helpers.addJob(
    "descript-clip-resolve",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
};
