import { describe, expect, it } from "vitest";
import { extractKlaviyoCampaignId } from "./newsletter";

describe("extractKlaviyoCampaignId", () => {
  it("pulls the id from the overview URL", () => {
    expect(
      extractKlaviyoCampaignId(
        "https://www.klaviyo.com/campaign/01K9V7E5C0570E92QJHK1XQF1M/reports/overview",
      ),
    ).toBe("01K9V7E5C0570E92QJHK1XQF1M");
  });

  it("pulls the id from the edit URL", () => {
    expect(
      extractKlaviyoCampaignId(
        "https://www.klaviyo.com/campaign/01K9V7E5C0570E92QJHK1XQF1M/edit",
      ),
    ).toBe("01K9V7E5C0570E92QJHK1XQF1M");
  });

  it("accepts the apex-domain variant", () => {
    expect(
      extractKlaviyoCampaignId(
        "https://klaviyo.com/campaign/01K9V7E5C0570E92QJHK1XQF1M/reports/overview",
      ),
    ).toBe("01K9V7E5C0570E92QJHK1XQF1M");
  });

  it("rejects non-Klaviyo hosts", () => {
    expect(
      extractKlaviyoCampaignId(
        "https://example.com/campaign/01K9V7E5C0570E92QJHK1XQF1M/reports/overview",
      ),
    ).toBeNull();
  });

  it("rejects malformed campaign ids", () => {
    expect(
      extractKlaviyoCampaignId(
        "https://www.klaviyo.com/campaign/not-a-ulid/reports/overview",
      ),
    ).toBeNull();
  });

  it("rejects non-URL strings", () => {
    expect(extractKlaviyoCampaignId("hello")).toBeNull();
  });

  it("returns null for null / empty input", () => {
    expect(extractKlaviyoCampaignId(null)).toBeNull();
    expect(extractKlaviyoCampaignId("")).toBeNull();
  });
});
