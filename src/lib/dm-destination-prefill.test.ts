import { describe, it, expect } from "vitest";
import { prefillDestination } from "./dm-destination-prefill";

const suggestion = "https://www.starterstory.com/data/one-page-websites?utm_campaign=owned&utm_id=gave-up-on-814";

describe("prefillDestination", () => {
  it("never carries over a keyword's go.starterstory.com link (another post's, or this post's own)", () => {
    // contentkit → cta-80c8c63e chained onto cta-ed4447b6 this way on 2026-10-15.
    expect(prefillDestination("https://go.starterstory.com/cta-ed4447b6", suggestion)).toBe(suggestion);
    expect(prefillDestination("https://go.starterstory.com/cta-80c8c63e?utm_id=x", suggestion)).toBe(suggestion);
  });

  it("leaves the field empty (not the go link) while the suggestion hasn't loaded", () => {
    expect(prefillDestination("https://go.starterstory.com/cta-ed4447b6", null)).toBe("");
  });

  it("keeps a real page someone chose", () => {
    const page = "https://www.starterstory.com/data/solo-devs-earning-10k-20k-month";
    expect(prefillDestination(page, suggestion)).toBe(page);
  });

  it("replaces an empty or bare-homepage default with the suggestion", () => {
    expect(prefillDestination("", suggestion)).toBe(suggestion);
    expect(prefillDestination("https://www.starterstory.com/", suggestion)).toBe(suggestion);
    expect(prefillDestination("", null)).toBe("");
  });

  it("leaves Rebrandly (MATG/MFM) per-post links alone — they're handled by the dialog's own branch", () => {
    expect(prefillDestination("https://clickhubspot.com/matg-p-1234abcd", suggestion)).toBe("https://clickhubspot.com/matg-p-1234abcd");
  });
});
