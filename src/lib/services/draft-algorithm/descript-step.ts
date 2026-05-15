import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  createDescriptProjectFromUrl,
  invokeDescriptAgent,
} from "@/lib/descript";
import { extractDescriptSection } from "@/lib/format-skill";
import { getPresignedGetUrl } from "@/lib/s3";
import { enqueue } from "@/jobs/enqueue";

export type DescriptStepStatus =
  | "triggered_warm"
  | "triggered_cold_import"
  | "skipped_no_skill"
  | "skipped_no_video_source"
  | "skipped_already_done";

export interface DescriptStepResult {
  status: DescriptStepStatus;
  jobId?: string;
  triggerId?: string;
}

interface RunDescriptStepArgs {
  derivativeItemId: string;
  pillarItemId: string | null;
  formatId: string;
  formatSkill: string | null;
  compositionName: string;
  /** True when the editor clicked Redraft — re-trigger even if a composition
   *  was already produced. False on normal Create-derivative retries (keeps
   *  the auto-fire path idempotent). */
  force: boolean;
}

/**
 * Descript branch of the Draft Algorithm. Fires when the target format is
 * flagged `is_clip_descript_format` (see `runDraftAlgorithm`).
 *
 * Two paths, picked by pillar state:
 *
 * **Warm (`triggered_warm`)** — pillar already has a `descriptProjectId`:
 *   1. Build an Underlord prompt from the format Skill's
 *      `### Descript Clip & Pack Info` section. No `{{hook}}` /
 *      `{{startTimestamp}}` substitution — the Skill is self-contained
 *      (e.g. "clip out the intro and only the intro"); Underlord reads the
 *      pillar's transcript inside Descript and picks the range.
 *   2. Invoke Descript's `/jobs/agent` against the pillar's project.
 *   3. Stamp `descriptProjectId/Url` on the derivative, clear any stale
 *      composition + publish state so the UI shows "Rendering…" until the
 *      poller updates.
 *   4. Insert a `repurpose_triggers` row (`descriptImportPath="agent"`),
 *      enqueue `descript-clip-resolve` to poll. The resolver writes the
 *      new composition_id back and auto-chains `descript-publish-and-archive`.
 *
 * **Cold (`triggered_cold_import`)** — pillar has `mediaS3Key` but no
 * `descriptProjectId` yet:
 *   1. Get a presigned GET URL for the pillar's S3 video.
 *   2. POST to Descript's import endpoint — creates a new project + an
 *      "imported" composition holding the full pillar video. Returns
 *      immediately with a job_id; the actual import runs ~30–60s on
 *      Descript's side.
 *   3. Stamp the pillar with the new `descriptProjectId / descriptProjectUrl
 *      / descriptImportedAt` IMMEDIATELY. Concurrent derivative requests for
 *      the same pillar will see it as "warm" and take the agent path.
 *      (Yes, there's a tiny window between presign + stamp where two
 *      requests could both upload — first writer wins on the stamp and the
 *      loser's project becomes an orphan. Tolerated for now; cheap to
 *      revisit if pillar-cold-imports ever pile up.)
 *   4. Stamp the derivative with the same project_id/url.
 *   5. Build the same Skill-driven agent prompt as the warm path; save it
 *      on the trigger via `descriptPrompt` so it round-trips with the
 *      payload across queue dequeue.
 *   6. Insert a `repurpose_triggers` row with the IMPORT job_id (not yet an
 *      agent job_id) and `descriptImportPath="agent-cold-import"`.
 *   7. Enqueue `descript-clip-resolve` with `importMode=true` AND
 *      `postImportAgentPrompt=<the prompt>`. The resolver: (a) stamps the
 *      imported composition_id on the pillar — warming it for future
 *      derivatives' duplicate-via-agent path; (b) skips writing the
 *      derivative's composition_id and publish-and-archive; (c) invokes the
 *      Descript agent with the saved prompt; (d) re-enqueues itself with
 *      the agent's new job_id (no importMode, no prompt). On the next
 *      stop, the resolver's existing non-import branch writes the
 *      derivative's final composition_id and chains the publish.
 *
 * **Skip cases:**
 *   - `skipped_no_skill` — format isn't flagged or has no Descript section.
 *   - `skipped_no_video_source` — pillar is text-only (no video, no S3
 *     media, no Descript project).
 *   - `skipped_already_done` — derivative already has a composition AND
 *     `force=false`. Redraft (`force=true`) bypasses this.
 *
 * Errors don't fail the draft. The caller swallows + logs so the caption
 * still saves even when Descript misbehaves.
 */
export async function runDescriptStepForDerivative(
  args: RunDescriptStepArgs,
): Promise<DescriptStepResult> {
  if (!args.pillarItemId) {
    return { status: "skipped_no_video_source" };
  }
  const descriptSkill = args.formatSkill
    ? extractDescriptSection(args.formatSkill).trim()
    : "";
  if (!descriptSkill) {
    return { status: "skipped_no_skill" };
  }

  const [derivative] = await db
    .select({
      descriptCompositionId: productionItems.descriptCompositionId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.derivativeItemId))
    .limit(1);
  if (!args.force && derivative?.descriptCompositionId) {
    return { status: "skipped_already_done" };
  }

  const [pillar] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.pillarItemId))
    .limit(1);

  // Pillar with no Descript project AND no S3 media → nothing to clip.
  if (!pillar || (!pillar.descriptProjectId && !pillar.mediaS3Key)) {
    return { status: "skipped_no_video_source" };
  }

  const prompt = buildDerivativeDescriptPrompt({
    skill: descriptSkill,
    compositionName: args.compositionName,
  });

  // COLD PATH: pillar has media but isn't in Descript. Upload it (one
  // round-trip to Descript's import endpoint, returns a job_id), stamp
  // the pillar early so a concurrent second derivative for the same
  // pillar sees it as warm, then enqueue the resolver with the
  // post-import agent prompt so Underlord runs once the import finishes.
  if (!pillar.descriptProjectId && pillar.mediaS3Key) {
    const presigned = await getPresignedGetUrl(pillar.mediaS3Key, 3600);
    const projectName = pillar.title ?? `Pillar ${pillar.id.slice(0, 8)}`;
    const importRes = await createDescriptProjectFromUrl({
      projectName,
      mediaUrl: presigned,
    });

    await db
      .update(productionItems)
      .set({
        descriptProjectId: importRes.project_id,
        descriptProjectUrl: importRes.project_url,
        descriptImportedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, pillar.id));

    await db
      .update(productionItems)
      .set({
        descriptProjectId: importRes.project_id,
        descriptProjectUrl: importRes.project_url,
        descriptCompositionId: null,
        descriptPublishJobId: null,
        descriptPublishedAt: null,
        descriptPublishError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, args.derivativeItemId));

    const [trigger] = await db
      .insert(repurposeTriggers)
      .values({
        productionItemId: args.pillarItemId,
        targetFormatId: args.formatId,
        descriptJobId: importRes.job_id,
        descriptProjectUrl: importRes.project_url,
        descriptPrompt: prompt,
        compositionName: args.compositionName,
        descriptImportPath: "agent-cold-import",
      })
      .returning({ id: repurposeTriggers.id });

    await enqueue("descript-clip-resolve", {
      triggerId: trigger.id,
      jobId: importRes.job_id,
      derivativeItemId: args.derivativeItemId,
      pillarItemId: pillar.id,
      importMode: true,
      postImportAgentPrompt: prompt,
    });

    return {
      status: "triggered_cold_import",
      jobId: importRes.job_id,
      triggerId: trigger.id,
    };
  }

  // WARM PATH: pillar already in Descript — invoke the agent directly.
  const agent = await invokeDescriptAgent({
    projectId: pillar.descriptProjectId!,
    prompt,
  });

  await db
    .update(productionItems)
    .set({
      descriptProjectId: pillar.descriptProjectId,
      descriptProjectUrl: pillar.descriptProjectUrl ?? agent.projectUrl,
      // Clear any previous composition so the UI shows "Rendering…" until
      // the resolver writes the new one. Force=true (Redraft) reuses this
      // path; we want the new comp to replace the old, not be ignored.
      descriptCompositionId: null,
      descriptPublishJobId: null,
      descriptPublishedAt: null,
      descriptPublishError: null,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, args.derivativeItemId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: args.pillarItemId,
      targetFormatId: args.formatId,
      descriptJobId: agent.jobId,
      descriptProjectUrl: agent.projectUrl,
      descriptPrompt: prompt,
      compositionName: args.compositionName,
      descriptImportPath: "agent",
    })
    .returning({ id: repurposeTriggers.id });

  await enqueue("descript-clip-resolve", {
    triggerId: trigger.id,
    jobId: agent.jobId,
    derivativeItemId: args.derivativeItemId,
  });

  return {
    status: "triggered_warm",
    jobId: agent.jobId,
    triggerId: trigger.id,
  };
}

/**
 * Build the Underlord prompt for a derivative whose format Skill carries
 * the clip instructions. Unlike `buildDescriptPrompt` in `promote-clip-idea`
 * (which pins a specific [start, end] range from a clip idea), this prompt
 * lets the agent read the transcript and pick the range itself — driven by
 * the Skill text (e.g. "clip out the intro"). Filler-word marking, layout
 * pack, etc. live in the same Skill section and apply to the new
 * composition the agent creates.
 */
export function buildDerivativeDescriptPrompt(args: {
  skill: string;
  compositionName: string;
}): string {
  const safeName = args.compositionName.replace(/"/g, '\\"');
  return [
    "You are producing a short-form vertical clip from this video. Follow these instructions exactly.",
    "",
    `1. Create a NEW composition named "${safeName}" — do not modify the source composition. Read the transcript to identify the segment described in the instructions below.`,
    "",
    "2. Apply the following format-specific instructions to the new composition:",
    "",
    args.skill,
    "",
    'Reply with the new compositionId in the form compositionId="<uuid>".',
  ].join("\n");
}
