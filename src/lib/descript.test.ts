import { describe, it, expect } from "vitest";
import { buildLayoutPackPrompt, substituteFormatPrompt } from "./descript";

// Pure unit test — no DB, no network. The Descript Underlord receives the
// output of this function verbatim; getting the substitution rules wrong
// silently corrupts every clip prompt. The substitution lives in a
// single place so tests here are cheap insurance.

describe("substituteFormatPrompt", () => {
  it("replaces {{hook}} with the hook text", () => {
    const out = substituteFormatPrompt(`Open with "{{hook}}".`, {
      hook: "Three SaaS ideas under $50/mo",
    });
    expect(out).toBe(`Open with "Three SaaS ideas under $50/mo".`);
  });

  it("escapes double-quotes in the hook so the prompt stays valid", () => {
    const out = substituteFormatPrompt(`Hook: "{{hook}}"`, {
      hook: 'He said "this is fake"',
    });
    expect(out).toBe(`Hook: "He said \\"this is fake\\""`);
  });

  it("substitutes timestamp + duration from startSec/endSec", () => {
    const out = substituteFormatPrompt(
      "Cut {{startTimestamp}}–{{endTimestamp}} ({{durationSec}}s) from {{startSec}}",
      {
        hook: "",
        startSec: 75,
        endSec: 145,
      },
    );
    expect(out).toBe("Cut 00:01:15–00:02:25 (70s) from 75");
  });

  it("leaves unknown placeholders untouched (safe failure mode)", () => {
    const out = substituteFormatPrompt(
      "Hook {{hook}} and {{nonExistent}} stays raw",
      { hook: "x" },
    );
    expect(out).toBe("Hook x and {{nonExistent}} stays raw");
  });

  it("supports whitespace inside the brace tokens", () => {
    const out = substituteFormatPrompt("{{ hook }}", { hook: "padded" });
    expect(out).toBe("padded");
  });

  it("renders empty strings for omitted timestamp vars (not 'undefined')", () => {
    // Agent flow doesn't pass startSec/endSec — the prompt template can
    // include {{startTimestamp}} unconditionally and it just becomes "".
    const out = substituteFormatPrompt("[{{startTimestamp}}]", { hook: "x" });
    expect(out).toBe("[]");
  });
});

describe("buildLayoutPackPrompt", () => {
  // A Skill that tells Underlord to re-clip — the exact instruction that
  // deletes a prepended intro on the +Underlord path.
  const SKILL = "I want you to only clip out the section about the tech stack.";

  it("passes the skill through unchanged by default (re-clip allowed)", () => {
    const out = buildLayoutPackPrompt({
      skill: SKILL,
      compositionId: "abc",
      hookText: "Hook",
    });
    expect(out).toContain("only clip out the section");
    expect(out).not.toMatch(/do NOT.*re-clip/i);
  });

  it("injects a no-trim override when an intro is prepended", () => {
    const out = buildLayoutPackPrompt({
      skill: SKILL,
      compositionId: "abc",
      hookText: "Hook",
      preserveAllFootage: true,
    });
    // Override appears before the skill text and is reinforced after it.
    expect(out.indexOf("OVERRIDES")).toBeLessThan(out.indexOf("only clip out"));
    expect(out).toMatch(/Keep every second/);
    expect(out).toMatch(/keep ALL footage/i);
    // The skill's own instruction is still present (we can't strip free-form
    // text) but is explicitly neutralized by the override.
    expect(out).toContain("only clip out the section");
    expect(out).toContain('compositionId="abc"');
  });
});
