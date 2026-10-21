import { describe, expect, it } from "vitest";
import { hubspotEmailName } from "@/lib/newsletter-template";

describe("hubspotEmailName", () => {
  it("follows each format's naming pattern from the send date", () => {
    expect(hubspotEmailName("{brand} | Newsletter | {Month} {D}", "Starter Story", "2026-09-24")).toBe("Starter Story | Newsletter | September 24");
    expect(hubspotEmailName("{brand} | Daily | {Mon}. {D}", "Starter Story", "2026-10-15")).toBe("Starter Story | Daily | Oct. 15");
  });

  it("falls back to today when the draft has no send date", () => {
    expect(hubspotEmailName("{brand} | Newsletter | {Month} {D}", "Starter Story", null, new Date("2026-11-03T15:00:00Z"))).toBe(
      "Starter Story | Newsletter | November 3",
    );
  });
});
