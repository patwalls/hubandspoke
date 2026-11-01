import { describe, expect, it, vi, afterEach } from "vitest";
import { ApiError } from "./http";
import { generateWebhookSecret, validateEvents, validateWebhookUrl } from "./webhooks";

describe("webhook validation", () => {
  it("accepts known events once each and rejects unknown ones", () => {
    expect(validateEvents(["content.published", "content.published", "transcript.ready"])).toEqual(["content.published", "transcript.ready"]);
    expect(() => validateEvents([])).toThrowError(ApiError);
    expect(() => validateEvents(["content.deleted"])).toThrowError(/Unknown event/);
  });
  it("normalizes the URL and rejects junk", async () => {
    await expect(validateWebhookUrl(" https://hooks.zapier.com/hooks/catch/1/abc ")).resolves.toBe("https://hooks.zapier.com/hooks/catch/1/abc");
    await expect(validateWebhookUrl("not a url")).rejects.toThrowError(ApiError);
  });
  describe("in production (S-204)", () => {
    afterEach(() => vi.unstubAllEnvs());
    const publicDns = async () => ["93.184.216.34"];
    it("accepts a public https host", async () => {
      vi.stubEnv("NODE_ENV", "production");
      await expect(validateWebhookUrl("https://hooks.zapier.com/x", publicDns)).resolves.toBe("https://hooks.zapier.com/x");
    });
    it.each(["https://172.16.0.1/x", "https://169.254.169.254/x", "https://[::1]/x", "https://2130706433/x", "http://hooks.zapier.com/x", "https://u:p@hooks.zapier.com/x"])(
      "refuses %s",
      async (url) => {
        vi.stubEnv("NODE_ENV", "production");
        await expect(validateWebhookUrl(url, publicDns)).rejects.toThrowError(ApiError);
      }
    );
    it("refuses a name that resolves to a private address", async () => {
      vi.stubEnv("NODE_ENV", "production");
      await expect(validateWebhookUrl("https://rebind.example.com/x", async () => ["10.0.0.5"])).rejects.toThrow(/reachable from the internet/);
    });
  });
  it("secrets are prefixed and unique", () => {
    const a = generateWebhookSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toBe(generateWebhookSecret());
  });
});
