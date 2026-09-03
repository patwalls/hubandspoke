import { describe, it, expect } from "vitest";
import { descriptAccountFromPayload } from "./descript-account";

describe("descriptAccountFromPayload", () => {
  // Regression (2026-09-03): the task used `payload.descriptAccount ?? "hubspot"`,
  // which collapsed a MEANINGFUL null (legacy account) into "hubspot" and
  // rerouted legacy-account jobs to the HubSpot workspace.
  it("preserves explicit null (legacy account)", () => {
    expect(descriptAccountFromPayload(null)).toBeNull();
  });

  it("falls back to hubspot only when the field is absent (pre-field payloads)", () => {
    expect(descriptAccountFromPayload(undefined)).toBe("hubspot");
  });

  it("passes through an explicit account", () => {
    expect(descriptAccountFromPayload("hubspot")).toBe("hubspot");
  });
});
