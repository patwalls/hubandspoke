import { describe, it, expect } from "vitest";
import { isFeatureEnabled, resolveFeatureFlags } from "./feature-flags";

describe("isFeatureEnabled", () => {
  it("is on for the hardcoded allowlist, case-insensitively", () => {
    expect(isFeatureEnabled("clipEditor", { email: "patrickswalls@gmail.com" }, {})).toBe(true);
    expect(isFeatureEnabled("clipEditor", { email: " PatrickSWalls@Gmail.com " }, {})).toBe(true);
  });

  it("is off for everyone else, including signed-out and email-less users", () => {
    expect(isFeatureEnabled("clipEditor", { email: "sam@example.com" }, {})).toBe(false);
    expect(isFeatureEnabled("clipEditor", { email: "" }, {})).toBe(false);
    expect(isFeatureEnabled("clipEditor", { email: null }, {})).toBe(false);
    expect(isFeatureEnabled("clipEditor", null, {})).toBe(false);
  });

  it("does not match on a substring or a lookalike domain", () => {
    expect(isFeatureEnabled("clipEditor", { email: "patrickswalls@gmail.com.evil.io" }, {})).toBe(false);
    expect(isFeatureEnabled("clipEditor", { email: "xpatrickswalls@gmail.com" }, {})).toBe(false);
  });

  it("the env var extends the allowlist and never replaces it", () => {
    const env = { FEATURE_CLIP_EDITOR_EMAILS: "e2e@local.test, Other@Example.com ,," };
    expect(isFeatureEnabled("clipEditor", { email: "e2e@local.test" }, env)).toBe(true);
    expect(isFeatureEnabled("clipEditor", { email: "other@example.com" }, env)).toBe(true);
    expect(isFeatureEnabled("clipEditor", { email: "patrickswalls@gmail.com" }, env)).toBe(true);
    expect(isFeatureEnabled("clipEditor", { email: "sam@example.com" }, env)).toBe(false);
  });

  it("an empty env entry never grants the flag to an email-less user", () => {
    expect(isFeatureEnabled("clipEditor", { email: "" }, { FEATURE_CLIP_EDITOR_EMAILS: "," })).toBe(false);
  });
});

describe("resolveFeatureFlags", () => {
  it("returns a boolean per flag and nothing else", () => {
    expect(resolveFeatureFlags({ email: "sam@example.com" }, {})).toEqual({ clipEditor: false });
    expect(resolveFeatureFlags({ email: "patrickswalls@gmail.com" }, {})).toEqual({ clipEditor: true });
  });
});
