import { describe, expect, it } from "vitest";
import { ApiError } from "./http";
import { generateWebhookSecret, validateEvents, validateWebhookUrl } from "./webhooks";

describe("webhook validation", () => {
  it("accepts known events once each and rejects unknown ones", () => {
    expect(validateEvents(["content.published", "content.published", "transcript.ready"])).toEqual(["content.published", "transcript.ready"]);
    expect(() => validateEvents([])).toThrowError(ApiError);
    expect(() => validateEvents(["content.deleted"])).toThrowError(/Unknown event/);
  });
  it("requires https in production and normalizes the URL", () => {
    expect(validateWebhookUrl(" https://hooks.zapier.com/hooks/catch/1/abc ")).toBe("https://hooks.zapier.com/hooks/catch/1/abc");
    expect(() => validateWebhookUrl("not a url")).toThrowError(ApiError);
  });
  it("secrets are prefixed and unique", () => {
    const a = generateWebhookSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toBe(generateWebhookSecret());
  });
});
