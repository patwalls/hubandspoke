/**
 * Unit tests for the Descript prompt builder. The end-to-end behavior of
 * `runDescriptStepForDerivative` is covered by
 * `descript-step.integration.test.ts` (real Postgres + mocked Descript API)
 * — that file's currently blocked by local-DB schema drift but will be the
 * regression net once `/pulldb` re-syncs.
 */

import { describe, expect, it } from "vitest";
import { buildDerivativeDescriptPrompt } from "./descript-step";

describe("buildDerivativeDescriptPrompt", () => {
  it("embeds the Skill text verbatim and escapes quotes in the composition name", () => {
    const out = buildDerivativeDescriptPrompt({
      skill: 'Cut "the intro" only.',
      compositionName: 'Angus "Cheng" intro',
    });
    expect(out).toContain('"Angus \\"Cheng\\" intro"');
    expect(out).toContain('Cut "the intro" only.');
    expect(out).toContain('compositionId="<uuid>"');
  });

  it("does not substitute Skill placeholders — Skill is self-contained for derivatives", () => {
    // Clip-idea promotion substitutes {{hook}} / {{startTimestamp}} from
    // the idea row. Derivative creation has neither, so the helper passes
    // the Skill through verbatim. If a future format Skill leans on
    // {{hook}} for derivative work too, we'd plumb it through here — but
    // for now, literal placeholders are the documented behavior.
    const out = buildDerivativeDescriptPrompt({
      skill: "Use {{hook}} and {{startTimestamp}}.",
      compositionName: "x",
    });
    expect(out).toContain("{{hook}}");
    expect(out).toContain("{{startTimestamp}}");
  });

  it("instructs the agent to create a new composition (not modify the source)", () => {
    const out = buildDerivativeDescriptPrompt({
      skill: "Anything.",
      compositionName: "My clip",
    });
    expect(out).toMatch(/Create a NEW composition/);
    expect(out).toMatch(/do not modify the source composition/);
  });
});
