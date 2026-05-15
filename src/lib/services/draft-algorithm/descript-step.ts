import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import { invokeDescriptAgent } from "@/lib/descript";
import { extractDescriptSection } from "@/lib/format-skill";
import { enqueue } from "@/jobs/enqueue";

export type DescriptStepStatus =
  | "triggered"
  | "skipped_no_skill"
  | "skipped_pillar_not_in_descript"
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
 * Optional Descript branch of the Draft Algorithm. Fires when the target
 * format is flagged `is_clip_descript_format` (see `runDraftAlgorithm`).
 *
 * What it does in the warm case (pillar already has a Descript project):
 *   1. Builds an Underlord prompt from the format Skill's
 *      `### Descript Clip & Pack Info` section. The Skill itself dictates
 *      what to cut (e.g. "clip out the intro and only the intro") and
 *      what treatment to apply (filler-word marking, layout pack). No
 *      hook / timestamp substitution — the agent reads the transcript
 *      inside Descript and figures out the range.
 *   2. Invokes the Descript `/jobs/agent` endpoint on the pillar's project.
 *   3. Inserts a `repurpose_triggers` row and stamps `descriptProjectId`
 *      + `descriptProjectUrl` on the derivative so the editor's detail
 *      page can link out to Descript while the job runs.
 *   4. Enqueues `descript-clip-resolve` which polls the job, writes the
 *      new `descriptCompositionId` back on the derivative, and auto-chains
 *      into `descript-publish-and-archive` to render and archive an MP4.
 *
 * Cold case (pillar has media but isn't in Descript yet): skipped with
 * `pillar_not_in_descript`. Promoting the pillar to Descript is currently a
 * separate manual / clip-idea flow; once the pillar is warm, the next
 * derivative for this format picks up Descript automatically. (Adding an
 * auto-import here is a fast-follow — would slot in via an extension to
 * `descript-clip-resolve` that chains an agent invocation after the import
 * job stops.)
 *
 * Errors don't fail the draft. The caller swallows + logs so the caption
 * still saves even when Descript / Underlord misbehaves.
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
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.pillarItemId))
    .limit(1);
  if (!pillar?.descriptProjectId) {
    return {
      status: pillar?.mediaS3Key
        ? "skipped_pillar_not_in_descript"
        : "skipped_no_video_source",
    };
  }

  const prompt = buildDerivativeDescriptPrompt({
    skill: descriptSkill,
    compositionName: args.compositionName,
  });
  const agent = await invokeDescriptAgent({
    projectId: pillar.descriptProjectId,
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

  return { status: "triggered", jobId: agent.jobId, triggerId: trigger.id };
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
