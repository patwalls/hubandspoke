import { describe, it, expect } from "vitest";
import { resolveDescriptAccountForActor } from "./descript-account";

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
