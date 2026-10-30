import { describe, it, expect } from "vitest";
import { isBlockedError } from "./blocked";

describe("isBlockedError", () => {
  it("is true for a structured blocked state, which the UI shows instead of Sentry", () => {
    expect(
      isBlockedError(new Error("blocked:needs_transcript: source x has no Whisper transcript")),
    ).toBe(true);
  });

  it("is false for real failures, which still page", () => {
    expect(isBlockedError(new Error("descript-derivative-create exceeded 10 attempts"))).toBe(false);
    expect(isBlockedError(new Error("Underlord 500: not blocked: at all"))).toBe(false);
    expect(isBlockedError(undefined)).toBe(false);
  });
});
