import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  createTestFormat,
  createTestProductionItem,
} from "@/test/factories";
import * as descriptApi from "@/lib/descript";
import * as s3Mod from "@/lib/s3";
import * as enqueueMod from "@/jobs/enqueue";
import * as derivativeHookMod from "./derivative-hook";
import {
  buildDerivativeDescriptPrompt,
  runDescriptStepForDerivative,
} from "./descript-step";

const CLIP_INTRO_SKILL = `### Descript Clip & Pack Info

I want you to clip out the intro and only the intro.

Inside the composition, mark filler words as IGNORED.

### Copywriting
Don't use em dashes.`;

const SKILL_WITH_HOOK_PLACEHOLDER = `### Descript Clip & Pack Info

Clip the tech-stack section.

Set the hook text track to: "{{hook}}". Replace whatever the layout pack provides.`;

const createdTriggerIds: string[] = [];

afterEach(async () => {
  // The factories don't track repurposeTriggers (no FK cascade), so the
  // production_items cleanup would fail with a FK violation. Drain the
  // triggers this test created first.
  while (createdTriggerIds.length > 0) {
    const id = createdTriggerIds.pop()!;
    await db
      .delete(repurposeTriggers)
      .where(eq(repurposeTriggers.id, id))
      .catch(() => {});
  }
  vi.restoreAllMocks();
});

describe("runDescriptStepForDerivative — Underlord auto-fire disabled (2026-05-18)", () => {
  it("returns skipped_underlord_disabled without invoking Underlord or enqueuing", async () => {
    const agentSpy = vi
      .spyOn(descriptApi, "invokeDescriptAgent")
      .mockResolvedValue({
        jobId: "should-not-fire",
        projectId: "should-not-fire",
        projectUrl: "should-not-fire",
      });
    const enqueueSpy = vi
      .spyOn(enqueueMod, "enqueue")
      .mockResolvedValue(undefined);

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      title: "Pillar with Descript",
      format: "Business Breakdown",
      sourceType: "original",
      descriptProjectId: "proj-pillar-1",
      descriptCompositionId: "comp-pillar-1",
      mediaS3Bucket: "test-bucket",
      mediaS3Key: "test/pillar.mp4",
    });
    const derivative = await createTestProductionItem({
      title: "Share The BIG IDEA derivative",
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: derivative.title!,
      force: false,
    });

    expect(result.status).toBe("skipped_underlord_disabled");
    expect(agentSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// Legacy tests for the enabled behavior. The Descript step is currently
// gated off by the `UNDERLORD_AUTO_FIRE_ENABLED` constant in
// `descript-step.ts` (added 2026-05-18 after a $35-in-30-min burn). If
// you flip the kill switch back on, also remove the `.skip` here to
// validate the existing prompt-building / cold-import / re-trigger
// behavior is unchanged.
describe.skip("runDescriptStepForDerivative (enabled-path tests, skipped while kill switch is on)", () => {
  it("invokes Underlord and enqueues poller when pillar is in Descript", async () => {
    const agentSpy = vi
      .spyOn(descriptApi, "invokeDescriptAgent")
      .mockResolvedValue({
        jobId: "job-warm-1",
        projectId: "proj-warm-1",
        projectUrl: "https://web.descript.com/proj-warm-1",
      });
    const enqueueSpy = vi
      .spyOn(enqueueMod, "enqueue")
      .mockResolvedValue(undefined);

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      title: "Pillar with Descript",
      format: "Business Breakdown",
      sourceType: "original",
      descriptProjectId: "proj-pillar-1",
      descriptProjectUrl: "https://web.descript.com/proj-pillar-1",
      descriptCompositionId: "comp-pillar-1",
      mediaS3Bucket: "test-bucket",
      mediaS3Key: "test/pillar.mp4",
    });
    const derivative = await createTestProductionItem({
      title: "Share The BIG IDEA derivative",
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: derivative.title!,
      force: false,
    });

    expect(result.status).toBe("triggered_warm");
    expect(result.jobId).toBe("job-warm-1");
    expect(result.triggerId).toBeDefined();
    if (result.triggerId) createdTriggerIds.push(result.triggerId);

    // Agent received the pillar's projectId and a prompt containing the
    // Skill's Descript section (the intro-only instruction) but NOT the
    // Copywriting section (that's editorial, not for Underlord).
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const promptArg = agentSpy.mock.calls[0][0].prompt;
    expect(agentSpy.mock.calls[0][0].projectId).toBe("proj-pillar-1");
    expect(promptArg).toContain("clip out the intro and only the intro");
    expect(promptArg).toContain("mark filler words as IGNORED");
    expect(promptArg).not.toContain("Don't use em dashes");

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0]).toBe("descript-clip-resolve");
    expect(enqueueSpy.mock.calls[0][1]).toMatchObject({
      jobId: "job-warm-1",
      derivativeItemId: derivative.id,
    });

    // Derivative now points at the pillar's Descript project and has its
    // composition cleared (poller will write the new comp id back).
    const [updated] = await db
      .select({
        descriptProjectId: productionItems.descriptProjectId,
        descriptProjectUrl: productionItems.descriptProjectUrl,
        descriptCompositionId: productionItems.descriptCompositionId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, derivative.id))
      .limit(1);
    expect(updated.descriptProjectId).toBe("proj-pillar-1");
    expect(updated.descriptProjectUrl).toBe(
      "https://web.descript.com/proj-pillar-1",
    );
    expect(updated.descriptCompositionId).toBeNull();
  });

  it("cold-imports the pillar to Descript when it has media but no project", async () => {
    // The agent invocation does NOT happen synchronously on the cold
    // path — it's deferred to descript-clip-resolve's post-import chain.
    // So the helper should only call createDescriptProjectFromUrl here.
    const agentSpy = vi.spyOn(descriptApi, "invokeDescriptAgent");
    const importSpy = vi
      .spyOn(descriptApi, "createDescriptProjectFromUrl")
      .mockResolvedValue({
        job_id: "import-job-1",
        project_id: "proj-cold-1",
        project_url: "https://web.descript.com/proj-cold-1",
      });
    vi.spyOn(s3Mod, "getPresignedGetUrl").mockResolvedValue(
      "https://s3.example/presigned.mp4",
    );
    const enqueueSpy = vi
      .spyOn(enqueueMod, "enqueue")
      .mockResolvedValue(undefined);

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      title: "Pillar with only S3 video",
      mediaS3Bucket: "test-bucket",
      mediaS3Key: "test/pillar.mp4",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("triggered_cold_import");
    expect(result.jobId).toBe("import-job-1");
    if (result.triggerId) createdTriggerIds.push(result.triggerId);

    // Underlord is NOT invoked yet — that happens in the resolver after
    // the import finishes.
    expect(agentSpy).not.toHaveBeenCalled();

    // Import call used the pillar's presigned S3 URL.
    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(importSpy.mock.calls[0][0].mediaUrl).toBe(
      "https://s3.example/presigned.mp4",
    );

    // Pillar stamped with the new project so concurrent / future
    // derivatives go through the warm path.
    const [pillarUpdated] = await db
      .select({
        descriptProjectId: productionItems.descriptProjectId,
        descriptProjectUrl: productionItems.descriptProjectUrl,
      })
      .from(productionItems)
      .where(eq(productionItems.id, pillar.id))
      .limit(1);
    expect(pillarUpdated.descriptProjectId).toBe("proj-cold-1");
    expect(pillarUpdated.descriptProjectUrl).toBe(
      "https://web.descript.com/proj-cold-1",
    );

    // Resolver got the post-import agent prompt so it can fire Underlord
    // when the import stops.
    expect(enqueueSpy).toHaveBeenCalledWith(
      "descript-clip-resolve",
      expect.objectContaining({
        jobId: "import-job-1",
        importMode: true,
        pillarItemId: pillar.id,
        derivativeItemId: derivative.id,
        postImportAgentPrompt: expect.stringContaining(
          "clip out the intro and only the intro",
        ),
      }),
    );
  });

  it("skips silently for text-only pillar (no media, no project)", async () => {
    const agentSpy = vi.spyOn(descriptApi, "invokeDescriptAgent");

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      title: "Text-only LinkedIn post",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("skipped_no_video_source");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("skips when format Skill has no Descript section", async () => {
    const agentSpy = vi.spyOn(descriptApi, "invokeDescriptAgent");

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: "## What this format is\n\nA short clip.",
    });
    // Even with a warm pillar — no skill, no fire. extractDescriptSection
    // falls back to the whole input when no heading exists, so the gate
    // is whether the section's *text* is non-empty after extraction.
    const pillar = await createTestProductionItem({
      descriptProjectId: "proj-pillar-1",
      descriptCompositionId: "comp-pillar-1",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      // Empty skill string — exercises the no_skill gate even though the
      // pillar is warm.
      formatSkill: "",
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("skipped_no_skill");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("skips re-trigger when derivative already has composition (force=false)", async () => {
    const agentSpy = vi.spyOn(descriptApi, "invokeDescriptAgent");

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      descriptProjectId: "proj-pillar-1",
      descriptCompositionId: "comp-pillar-1",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
      descriptCompositionId: "existing-comp",
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("skipped_already_done");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("re-triggers Descript on Redraft (force=true) even with existing composition", async () => {
    const agentSpy = vi
      .spyOn(descriptApi, "invokeDescriptAgent")
      .mockResolvedValue({
        jobId: "job-redraft-1",
        projectId: "proj-pillar-1",
        projectUrl: "https://web.descript.com/proj-pillar-1",
      });
    vi.spyOn(enqueueMod, "enqueue").mockResolvedValue(undefined);

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      descriptProjectId: "proj-pillar-1",
      descriptProjectUrl: "https://web.descript.com/proj-pillar-1",
      descriptCompositionId: "comp-pillar-1",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
      descriptCompositionId: "stale-comp-from-previous-run",
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "redraft-name",
      force: true,
    });

    expect(result.status).toBe("triggered_warm");
    expect(agentSpy).toHaveBeenCalledTimes(1);
    if (result.triggerId) createdTriggerIds.push(result.triggerId);

    // The stale composition is cleared so the UI doesn't keep linking the
    // user to the old cut while the new render is pending.
    const [updated] = await db
      .select({
        descriptCompositionId: productionItems.descriptCompositionId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, derivative.id))
      .limit(1);
    expect(updated.descriptCompositionId).toBeNull();
  });
});

describe("buildDerivativeDescriptPrompt", () => {
  it("escapes double-quotes in composition name and embeds skill verbatim", () => {
    const out = buildDerivativeDescriptPrompt({
      skill: 'Cut from "intro" to "the big idea".',
      compositionName: 'Angus "Cheng" intro',
    });
    expect(out).toContain('"Angus \\"Cheng\\" intro"');
    expect(out).toContain('Cut from "intro" to "the big idea".');
    expect(out).toContain('compositionId="<uuid>"');
  });
});

describe.skip("runDescriptStepForDerivative — {{hook}} substitution (enabled-path, skipped while kill switch is on)", () => {
  it("generates a hook, persists it, and substitutes into the Descript prompt", async () => {
    const agentSpy = vi
      .spyOn(descriptApi, "invokeDescriptAgent")
      .mockResolvedValue({
        jobId: "job-hook-1",
        projectId: "proj-pillar-h1",
        projectUrl: "https://web.descript.com/proj-pillar-h1",
      });
    vi.spyOn(enqueueMod, "enqueue").mockResolvedValue(undefined);
    const hookSpy = vi
      .spyOn(derivativeHookMod, "generateDerivativeHook")
      .mockResolvedValue({
        ok: true,
        value: {
          hook: "He built one website that prints $40K/month 😲",
          source: "derivative-hook-v1",
          extractor: "gpt-4.1-mini:derivative-hook:v1",
          exemplarCount: 5,
        },
      });

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: SKILL_WITH_HOOK_PLACEHOLDER,
    });
    const pillar = await createTestProductionItem({
      title: "Pillar with Descript",
      descriptProjectId: "proj-pillar-h1",
      descriptProjectUrl: "https://web.descript.com/proj-pillar-h1",
      descriptCompositionId: "comp-pillar-h1",
    });
    const derivative = await createTestProductionItem({
      title: "Derivative needing hook",
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: SKILL_WITH_HOOK_PLACEHOLDER,
      compositionName: derivative.title!,
      force: false,
    });

    expect(result.status).toBe("triggered_warm");
    if (result.triggerId) createdTriggerIds.push(result.triggerId);

    expect(hookSpy).toHaveBeenCalledTimes(1);
    expect(hookSpy.mock.calls[0][0]).toMatchObject({
      formatName: format.name,
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
    });

    // The prompt fired to Underlord has the hook substituted in — no
    // literal placeholder left.
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const promptArg = agentSpy.mock.calls[0][0].prompt;
    expect(promptArg).toContain("He built one website that prints $40K/month");
    expect(promptArg).not.toContain("{{hook}}");

    // Hook is persisted on the derivative row with the right source so
    // future audits / reporting can attribute the hook to this pipeline.
    const [updated] = await db
      .select({
        hook: productionItems.hook,
        hookSource: productionItems.hookSource,
        hookExtractor: productionItems.hookExtractor,
        hookExtractedAt: productionItems.hookExtractedAt,
      })
      .from(productionItems)
      .where(eq(productionItems.id, derivative.id))
      .limit(1);
    expect(updated.hook).toBe("He built one website that prints $40K/month 😲");
    expect(updated.hookSource).toBe("derivative-hook-v1");
    expect(updated.hookExtractor).toContain("derivative-hook");
    expect(updated.hookExtractedAt).not.toBeNull();
  });

  it("fails soft when hook generation fails — placeholder passes through, clip still fires", async () => {
    const agentSpy = vi
      .spyOn(descriptApi, "invokeDescriptAgent")
      .mockResolvedValue({
        jobId: "job-hook-fail-1",
        projectId: "proj-pillar-h2",
        projectUrl: "https://web.descript.com/proj-pillar-h2",
      });
    vi.spyOn(enqueueMod, "enqueue").mockResolvedValue(undefined);
    vi.spyOn(derivativeHookMod, "generateDerivativeHook").mockResolvedValue({
      ok: false,
      failure: { reason: "no-pillar-transcript" },
    });

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: SKILL_WITH_HOOK_PLACEHOLDER,
    });
    const pillar = await createTestProductionItem({
      descriptProjectId: "proj-pillar-h2",
      descriptCompositionId: "comp-pillar-h2",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: SKILL_WITH_HOOK_PLACEHOLDER,
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("triggered_warm");
    if (result.triggerId) createdTriggerIds.push(result.triggerId);

    // The clip fires even though hook generation failed — but the prompt
    // still contains the literal placeholder so the failure is visible
    // in the resulting composition. Better than silently dropping the
    // whole Descript step.
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const promptArg = agentSpy.mock.calls[0][0].prompt;
    expect(promptArg).toContain("{{hook}}");

    // Derivative's hook column is NOT written when generation fails —
    // we don't want to stamp a junk hook just because the placeholder
    // was in the Skill.
    const [updated] = await db
      .select({ hook: productionItems.hook })
      .from(productionItems)
      .where(eq(productionItems.id, derivative.id))
      .limit(1);
    expect(updated.hook).toBeNull();
  });

  it("skips hook generation entirely when the Skill has no {{hook}} placeholder", async () => {
    vi.spyOn(descriptApi, "invokeDescriptAgent").mockResolvedValue({
      jobId: "job-no-hook-1",
      projectId: "proj-pillar-n1",
      projectUrl: "https://web.descript.com/proj-pillar-n1",
    });
    vi.spyOn(enqueueMod, "enqueue").mockResolvedValue(undefined);
    const hookSpy = vi.spyOn(derivativeHookMod, "generateDerivativeHook");

    const format = await createTestFormat({
      isClippableFormat: true,
      instructions: CLIP_INTRO_SKILL,
    });
    const pillar = await createTestProductionItem({
      descriptProjectId: "proj-pillar-n1",
      descriptCompositionId: "comp-pillar-n1",
    });
    const derivative = await createTestProductionItem({
      format: format.name,
      sourceType: "repurposed",
      pillarContentItemId: pillar.id,
    });

    const result = await runDescriptStepForDerivative({
      derivativeItemId: derivative.id,
      pillarItemId: pillar.id,
      formatId: format.id,
      formatName: format.name,
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("triggered_warm");
    if (result.triggerId) createdTriggerIds.push(result.triggerId);
    // No placeholder in the Skill → don't burn a Haiku call.
    expect(hookSpy).not.toHaveBeenCalled();
  });
});
