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

  it("passes Skill placeholders through verbatim when no hook is supplied", () => {
    // When the caller doesn't pass a hook (Skill has no {{hook}}, or hook
    // generation failed and the fail-soft path kicked in), the helper
    // renders the Skill as-is so the failure is visible in the prompt
    // rather than silently swallowed.
    const out = buildDerivativeDescriptPrompt({
      skill: "Use {{hook}} and {{startTimestamp}}.",
      compositionName: "x",
    });
    expect(out).toContain("{{hook}}");
    expect(out).toContain("{{startTimestamp}}");
  });

  it("substitutes {{hook}} when a hook is supplied", () => {
    const out = buildDerivativeDescriptPrompt({
      skill: 'Set the hook track to "{{hook}}".',
      compositionName: "x",
      hook: "This founder built $40K/month from one website",
    });
    expect(out).toContain(
      '"This founder built $40K/month from one website"',
    );
    expect(out).not.toContain("{{hook}}");
  });

  it("escapes double-quotes inside the substituted hook", () => {
    // The format author wraps `{{hook}}` in quotes inside their Skill.
    // If the hook itself contains a quote, the resulting prompt could
    // confuse Underlord — so substituteFormatPrompt backslash-escapes.
    const out = buildDerivativeDescriptPrompt({
      skill: 'Set hook to "{{hook}}".',
      compositionName: "x",
      hook: 'He said "ship it" and meant it',
    });
    expect(out).toContain('"He said \\"ship it\\" and meant it"');
  });

  it("supports the spaced {{ hook }} variant", () => {
    const out = buildDerivativeDescriptPrompt({
      skill: "Hook: {{ hook }}",
      compositionName: "x",
      hook: "Tiny tech stack, $440K/month",
    });
    expect(out).toContain("Hook: Tiny tech stack, $440K/month");
    expect(out).not.toContain("{{ hook }}");
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
