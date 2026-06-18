import { describe, it, expect } from "vitest";
import { ssLeadsOf, hsLeadsOf } from "./performance-table";

// The Content performance table splits the single `leads` total into two
// sortable columns: HS (the HubSpot-form subset) and SS (the native remainder).
// These helpers own that split; the column cells and the sort comparator both
// route through them, so the branches below are the contract.
describe("performance-table leads split", () => {
  it("returns null for both when the post has no leads (renders '-', sorts last)", () => {
    expect(ssLeadsOf({ leads: null, hubspotLeads: null })).toBeNull();
    expect(hsLeadsOf({ leads: null, hubspotLeads: null })).toBeNull();
    // A stray hubspotLeads with no total is still treated as "no leads".
    expect(ssLeadsOf({ leads: null, hubspotLeads: 5 })).toBeNull();
    expect(hsLeadsOf({ leads: null, hubspotLeads: 5 })).toBeNull();
  });

  it("treats an unsynced HubSpot subset (null) as 0 HS, all leads native", () => {
    expect(ssLeadsOf({ leads: 10, hubspotLeads: null })).toBe(10);
    expect(hsLeadsOf({ leads: 10, hubspotLeads: null })).toBe(0);
  });

  it("splits total into native (SS) and HubSpot (HS)", () => {
    expect(hsLeadsOf({ leads: 10, hubspotLeads: 4 })).toBe(4);
    expect(ssLeadsOf({ leads: 10, hubspotLeads: 4 })).toBe(6);
  });

  it("clamps SS at 0 when the HubSpot subset exceeds the total (eventual-consistency skew)", () => {
    // The two counts come from separate fields on the same link and can briefly
    // disagree; SS must never go negative.
    expect(ssLeadsOf({ leads: 3, hubspotLeads: 5 })).toBe(0);
    expect(hsLeadsOf({ leads: 3, hubspotLeads: 5 })).toBe(5);
  });
});
