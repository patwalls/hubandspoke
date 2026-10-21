import { describe, expect, it } from "vitest";
import { hubspotEmailName } from "./hubspot-newsletter-create-draft";

describe("hubspotEmailName", () => {
  it("follows the team's 'Brand | Newsletter | Month Day' convention using the send date", () => {
    expect(hubspotEmailName("Starter Story", "2026-09-24")).toBe("Starter Story | Newsletter | September 24");
    expect(hubspotEmailName("Starter Story", "2026-10-25")).toBe("Starter Story | Newsletter | October 25");
  });

  it("falls back to today when the draft has no send date", () => {
    expect(hubspotEmailName("Starter Story", null, new Date("2026-11-03T15:00:00Z"))).toBe("Starter Story | Newsletter | November 3");
  });
});
