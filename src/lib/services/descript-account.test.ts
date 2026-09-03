import { describe, it, expect } from "vitest";
import {
  descriptAccountFromPayload,
  resolveDescriptAccountForActor,
} from "./descript-account";

describe("resolveDescriptAccountForActor", () => {
  it("routes Pat's promotions to the legacy account (NULL)", () => {
    expect(resolveDescriptAccountForActor("patrickswalls@gmail.com")).toBeNull();
  });

  it("is case-insensitive on the email", () => {
    expect(resolveDescriptAccountForActor("PatrickSWalls@Gmail.com")).toBeNull();
  });

  it("routes everyone else to the HubSpot workspace", () => {
    expect(resolveDescriptAccountForActor("sam@starterstory.com")).toBe(
      "hubspot",
    );
  });

  it("defaults to HubSpot when the actor has no email", () => {
    expect(resolveDescriptAccountForActor(null)).toBe("hubspot");
  });
});

describe("descriptAccountFromPayload", () => {
  // Regression (2026-09-03): the task used `payload.descriptAccount ?? "hubspot"`,
  // which collapsed the MEANINGFUL null (legacy account) into "hubspot" and
  // sent Pat's promotions to the HubSpot workspace anyway.
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
