import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  createDescriptProjectFromUrl,
  invokeDescriptAgent,
  substituteFormatPrompt,
} from "@/lib/descript";
import { NEW_DESCRIPT_PROJECT_ACCOUNT } from "@/lib/services/descript-account";
import { extractDescriptSection } from "@/lib/format-skill";
import { getPresignedGetUrl } from "@/lib/s3";
import { enqueue } from "@/jobs/enqueue";
import {
  generateDerivativeHook,
  skillUsesHookPlaceholder,
} from "./derivative-hook";

export type DescriptStepStatus =
  | "triggered_warm"
  | "triggered_cold_import"
  | "skipped_no_skill"
  | "skipped_no_video_source"
  | "skipped_already_done"
  /** 2026-05-18: Underlord auto-fire disabled. The Descript step used to
   *  invoke the agent on every derivative create whose format Skill
   *  carried `### Descript Clip & Pack Info`. After a $35/30min burn from
   *  background Underlord calls, the step now short-circuits and the
   *  Underlord call only happens when an operator explicitly clicks a
   *  clip-idea promote button. The early-return preserves the surrounding
   *  gate logic so re-enabling is a one-line revert. */
  | "skipped_underlord_disabled";

export interface DescriptStepResult {
  status: DescriptStepStatus;
  jobId?: string;
  triggerId?: string;
}

interface RunDescriptStepArgs {
  derivativeItemId: string;
  pillarItemId: string | null;
  formatId: string;
  formatName: string;
  brand: string;
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
 *      `### Descript Clip & Pack Info` section. If the Skill contains
 *      `{{hook}}`, generate a derivative-specific hook first
 *      (`generateDerivativeHook` — Haiku 4.5 grounded in past in-format
 *      hooks + pillar transcript), persist it on the derivative row, and
 *      substitute it into the prompt via `substituteFormatPrompt`. No
 *      transcript ⇒ fail-soft, placeholder passes through to Underlord
 *      and a warning is logged (better than blocking the clip).
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
/** 2026-05-18: Underlord auto-fire kill switch. Flip to `true` to re-enable
 *  the Draft Algorithm's Descript step (one Underlord call per derivative
 *  whose format Skill has `### Descript Clip & Pack Info`). Off because Pat
 *  burned $35 in 30 minutes from background calls; the policy is now
 *  "Underlord only fires on explicit clip-idea promote buttons." */
const UNDERLORD_AUTO_FIRE_ENABLED = false;

export async function runDescriptStepForDerivative(
  args: RunDescriptStepArgs,
): Promise<DescriptStepResult> {
  if (!UNDERLORD_AUTO_FIRE_ENABLED) {
    console.info(
      `descript-step item=${args.derivativeItemId} skipped (Underlord auto-fire disabled — promote via /api/clip-ideas/[id]/create-in-descript* to invoke explicitly)`,
    );
    return { status: "skipped_underlord_disabled" };
  }

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
      descriptAccount: productionItems.descriptAccount,
      mediaS3Key: productionItems.mediaS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.pillarItemId))
    .limit(1);

  // Pillar with no Descript project AND no S3 media → nothing to clip.
  if (!pillar || (!pillar.descriptProjectId && !pillar.mediaS3Key)) {
    return { status: "skipped_no_video_source" };
  }

  // Generate-then-substitute `{{hook}}` if the Skill uses the placeholder.
  // Fail-soft: any failure (no transcript, LLM error) leaves the placeholder
  // intact and logs a warning, so the clip still fires. The trade-off is a
  // bad-but-known hook ("{{ hook }}") vs. an aborted Draft Algorithm step.
  let derivativeHook: string | null = null;
  if (skillUsesHookPlaceholder(descriptSkill)) {
    const result = await generateDerivativeHook({
      formatName: args.formatName,
      brand: args.brand,
      derivativeItemId: args.derivativeItemId,
      pillarItemId: args.pillarItemId,
      skillSection: descriptSkill,
    });
    if (result.ok) {
      derivativeHook = result.value.hook;
      await db
        .update(productionItems)
        .set({
          hook: result.value.hook,
          hookSource: result.value.source,
          hookExtractor: result.value.extractor,
          hookExtractedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, args.derivativeItemId));
    } else {
      console.warn(
        `descript-step item=${args.derivativeItemId} hook-generation failed: ${result.failure.reason} — firing Descript with literal {{hook}}; Underlord will stamp the placeholder. Fix: add pillar transcript or check Anthropic credentials.`,
      );
    }
  }

  const prompt = buildDerivativeDescriptPrompt({
    skill: descriptSkill,
    compositionName: args.compositionName,
    hook: derivativeHook,
  });

  // COLD PATH: pillar has media but isn't in Descript. Upload it (one
  // round-trip to Descript's import endpoint, returns a job_id), stamp
  // the pillar early so a concurrent second derivative for the same
  // pillar sees it as warm, then enqueue the resolver with the
  // post-import agent prompt so Underlord runs once the import finishes.
  if (!pillar.descriptProjectId && pillar.mediaS3Key) {
    const presigned = await getPresignedGetUrl(pillar.mediaS3Key, 3600, {
      bucket: pillar.mediaS3Bucket ?? undefined,
    });
    const projectName = pillar.title ?? `Pillar ${pillar.id.slice(0, 8)}`;
    const importRes = await createDescriptProjectFromUrl({
      projectName,
      mediaUrl: presigned,
      account: NEW_DESCRIPT_PROJECT_ACCOUNT,
    });

    await db
      .update(productionItems)
      .set({
        descriptProjectId: importRes.project_id,
        descriptProjectUrl: importRes.project_url,
        descriptAccount: NEW_DESCRIPT_PROJECT_ACCOUNT,
        descriptImportedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, pillar.id));

    await db
      .update(productionItems)
      .set({
        descriptProjectId: importRes.project_id,
        descriptProjectUrl: importRes.project_url,
        descriptAccount: NEW_DESCRIPT_PROJECT_ACCOUNT,
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

  // WARM PATH: pillar already in Descript — invoke the agent directly, in
  // whichever account owns the pillar's project (NULL stamp = legacy).
  const agent = await invokeDescriptAgent({
    projectId: pillar.descriptProjectId!,
    prompt,
    caller: "draft-algorithm-descript-step",
    productionItemId: args.derivativeItemId,
    account: pillar.descriptAccount,
  });

  await db
    .update(productionItems)
    .set({
      descriptProjectId: pillar.descriptProjectId,
      descriptProjectUrl: pillar.descriptProjectUrl ?? agent.projectUrl,
      descriptAccount: pillar.descriptAccount,
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
  /** Generated by `generateDerivativeHook` upstream. When present,
   *  `{{hook}}` (and `{{ hook }}`) placeholders in the Skill are
   *  substituted with quote-escaping via `substituteFormatPrompt`. When
   *  null, the Skill is rendered verbatim — useful for formats whose
   *  Skill doesn't use the placeholder (and for fail-soft, when hook
   *  generation didn't produce one). */
  hook?: string | null;
}): string {
  const safeName = args.compositionName.replace(/"/g, '\\"');
  const renderedSkill =
    args.hook != null
      ? substituteFormatPrompt(args.skill, { hook: args.hook })
      : args.skill;
  // The prompt is opinionated for a reason: Underlord otherwise tends to
  // (a) silently no-op when the Skill's segment description is vague —
  // returning the source composition's id and applying only the
  // filler/silence cleanup — and (b) end clips mid-sentence because
  // there's no explicit "land on punctuation" rule. The numbered steps
  // and the bolded boundary rules below are belt-and-suspenders against
  // both failure modes, observed on real prod runs.
  return [
    "You are producing a short-form vertical clip from a long-form source video. Follow these instructions exactly.",
    "",
    "1. Create a NEW composition — do not modify the source composition. Do not return the source composition's id.",
    `   Name the new composition exactly: "${safeName}". This name is an internal lookup key for editors; do NOT render it as a visible title overlay or title-card text. Title / hook overlays (if the layout pack uses one) should come from the format-specific instructions below.`,
    "",
    "2. Read the source composition's transcript end-to-end, then identify the contiguous segment described in the format-specific instructions.",
    "",
    "3. Trim the new composition to that segment. The trim MUST satisfy all of these:",
    "   - STRICT SUBSET: the new composition is strictly shorter than the source, with both endpoints inside the source's timeline.",
    "   - CLEAN START: begin on the FIRST word of a natural sentence boundary (a sentence-starting cap or a speaker turn). Do NOT begin mid-sentence.",
    "   - CLEAN END: end on the LAST word of a sentence-ending punctuation mark (period, question mark, or exclamation point). Do NOT end mid-sentence, mid-clause, or on a trailing filler word.",
    "   - NO-OP REFUSAL: if you cannot confidently identify the requested segment, REPLY with a one-line error explanation. Do NOT copy the source as a fallback.",
    "",
    "4. Apply the following format-specific instructions to the trimmed composition:",
    "",
    renderedSkill,
    "",
    'Reply with the new compositionId in the form compositionId="<uuid>".',
  ].join("\n");
}
