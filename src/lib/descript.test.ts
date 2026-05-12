import { describe, it, expect } from "vitest";
import { substituteFormatPrompt } from "./descript";

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
