import { describe, it, expect } from "vitest";
import { isEnabledFor, isFeatureEnabled, resolveFeatureFlags, type FlagDefinition } from "./feature-flags";

// Allowlist semantics are tested against a fixture flag so they keep coverage
// after the real flags roll out to everyone.
const allowlisted: FlagDefinition = {
  emails: ["patrickswalls@gmail.com"],
  envVar: "FEATURE_TEST_EMAILS",
};

describe("isEnabledFor (allowlist flag)", () => {
  it("is on for the hardcoded allowlist, case-insensitively", () => {
    expect(isEnabledFor(allowlisted, { email: "patrickswalls@gmail.com" }, {})).toBe(true);
    expect(isEnabledFor(allowlisted, { email: " PatrickSWalls@Gmail.com " }, {})).toBe(true);
  });

  it("is off for everyone else, including signed-out and email-less users", () => {
    expect(isEnabledFor(allowlisted, { email: "sam@example.com" }, {})).toBe(false);
    expect(isEnabledFor(allowlisted, { email: "" }, {})).toBe(false);
    expect(isEnabledFor(allowlisted, { email: null }, {})).toBe(false);
    expect(isEnabledFor(allowlisted, null, {})).toBe(false);
  });

  it("does not match on a substring or a lookalike domain", () => {
    expect(isEnabledFor(allowlisted, { email: "patrickswalls@gmail.com.evil.io" }, {})).toBe(false);
    expect(isEnabledFor(allowlisted, { email: "xpatrickswalls@gmail.com" }, {})).toBe(false);
  });

  it("the env var extends the allowlist and never replaces it", () => {
    const env = { FEATURE_TEST_EMAILS: "e2e@local.test, Other@Example.com ,," };
    expect(isEnabledFor(allowlisted, { email: "e2e@local.test" }, env)).toBe(true);
    expect(isEnabledFor(allowlisted, { email: "other@example.com" }, env)).toBe(true);
    expect(isEnabledFor(allowlisted, { email: "patrickswalls@gmail.com" }, env)).toBe(true);
    expect(isEnabledFor(allowlisted, { email: "sam@example.com" }, env)).toBe(false);
  });

  it("an empty env entry never grants the flag to an email-less user", () => {
    expect(isEnabledFor(allowlisted, { email: "" }, { FEATURE_TEST_EMAILS: "," })).toBe(false);
  });
});

describe("isEnabledFor (everyone flag)", () => {
  const everyone: FlagDefinition = { ...allowlisted, everyone: true };

  it("is on for any signed-in user, not just the allowlist", () => {
    expect(isEnabledFor(everyone, { email: "brand-new-user@example.com" }, {})).toBe(true);
  });

  it("is still off for signed-out and email-less users", () => {
    expect(isEnabledFor(everyone, { email: "" }, {})).toBe(false);
    expect(isEnabledFor(everyone, { email: null }, {})).toBe(false);
    expect(isEnabledFor(everyone, null, {})).toBe(false);
  });
});

describe("isFeatureEnabled", () => {
  it("clip and design editors are on for every signed-in account", () => {
    expect(isFeatureEnabled("clipEditor", { email: "someone-new@example.com" }, {})).toBe(true);
    expect(isFeatureEnabled("designEditor", { email: "someone-new@example.com" }, {})).toBe(true);
    expect(isFeatureEnabled("clipEditor", null, {})).toBe(false);
  });
});

describe("resolveFeatureFlags", () => {
  it("returns a boolean per flag and nothing else", () => {
    expect(resolveFeatureFlags({ email: "sam@example.com" }, {})).toEqual({ clipEditor: true, designEditor: true });
    expect(resolveFeatureFlags(null, {})).toEqual({ clipEditor: false, designEditor: false });
  });
});
