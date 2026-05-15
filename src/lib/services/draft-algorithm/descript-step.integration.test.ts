import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  createTestFormat,
  createTestProductionItem,
} from "@/test/factories";
import * as descriptApi from "@/lib/descript";
import * as enqueueMod from "@/jobs/enqueue";
import {
  buildDerivativeDescriptPrompt,
  runDescriptStepForDerivative,
} from "./descript-step";

const CLIP_INTRO_SKILL = `### Descript Clip & Pack Info

I want you to clip out the intro and only the intro.

Inside the composition, mark filler words as IGNORED.

### Copywriting
Don't use em dashes.`;

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

describe("runDescriptStepForDerivative", () => {
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
      isClipDescriptFormat: true,
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
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: derivative.title!,
      force: false,
    });

    expect(result.status).toBe("triggered");
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

  it("skips when pillar has media but is not in Descript yet", async () => {
    const agentSpy = vi
      .spyOn(descriptApi, "invokeDescriptAgent")
      .mockResolvedValue({
        jobId: "should-not-fire",
        projectId: "x",
        projectUrl: "x",
      });

    const format = await createTestFormat({
      isClipDescriptFormat: true,
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
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "anything",
      force: false,
    });

    expect(result.status).toBe("skipped_pillar_not_in_descript");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("skips silently for text-only pillar (no media, no project)", async () => {
    const agentSpy = vi.spyOn(descriptApi, "invokeDescriptAgent");

    const format = await createTestFormat({
      isClipDescriptFormat: true,
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
      isClipDescriptFormat: true,
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
      isClipDescriptFormat: true,
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
      isClipDescriptFormat: true,
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
      formatSkill: CLIP_INTRO_SKILL,
      compositionName: "redraft-name",
      force: true,
    });

    expect(result.status).toBe("triggered");
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
