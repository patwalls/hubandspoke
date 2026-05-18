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

  it("forbids mid-sentence cuts and silent no-ops", () => {
    // Two real failure modes observed on prod runs:
    //   1. Underlord ending the clip mid-sentence ("…and that's why we"); the
    //      prompt now demands the trim end on sentence-ending punctuation.
    //   2. Underlord silently returning the source composition's id when the
    //      Skill's segment description is vague — applying only the
    //      filler/silence cleanup. The prompt now demands a one-line error
    //      reply instead of a no-op copy.
    // If these guarantees ever get loosened the regression is invisible
    // until a clip ships looking wrong, so freeze them here.
    const out = buildDerivativeDescriptPrompt({
      skill: "clip the intro.",
      compositionName: "x",
    });
    expect(out).toMatch(/sentence-ending punctuation/i);
    expect(out).toMatch(/Do NOT begin mid-sentence/i);
    expect(out).toMatch(/strict subset/i);
    expect(out).toMatch(/Do NOT copy the source as a fallback/i);
  });

  it("tells the agent the composition name is internal — not a title overlay", () => {
    // Composition names include the production_item_id in brackets for
    // editor lookup. A layout pack that picks up the composition name as
    // the title-card text would render `[5b94...]` into the MP4. The
    // prompt now explicitly tells Underlord the name is internal-only
    // and title text should come from the Skill (typically a hook
    // placeholder the Skill author sets).
    const out = buildDerivativeDescriptPrompt({
      skill: "Anything.",
      compositionName: "Some title [5b94633a-e1bf-49da-926e-9d53d1e8c208]",
    });
    expect(out).toMatch(/internal lookup key/i);
    expect(out).toMatch(/do NOT render it as a visible title overlay/i);
  });
});
