import { describe, it, expect, vi } from "vitest";
import {
  applyPostUtms,
  formatOfferCta,
  isHubSpotShortLink,
  parseOfferToolInput,
  resolveRedirects,
  stripTrackingParams,
  usesCtaOffer,
} from "./cta-offer";

describe("usesCtaOffer", () => {
  it("is on for MATG only", () => {
    expect(usesCtaOffer("matg")).toBe(true);
    expect(usesCtaOffer("starter-story")).toBe(false);
    expect(usesCtaOffer("my-first-million")).toBe(false);
    expect(usesCtaOffer(null)).toBe(false);
  });
});

describe("stripTrackingParams", () => {
  it("drops the old placement's UTMs and HubSpot params but keeps the offer's own", () => {
    const url =
      "https://offers.hubspot.com/ai-guide?utm_source=youtube&utm_medium=video&utm_campaign=matg-ep12&hsa_cam=1&_hsenc=abc&__hsfp=9&hsCtaTracking=x&offer=42";
    expect(stripTrackingParams(url)).toBe("https://offers.hubspot.com/ai-guide?offer=42");
  });

  it("then takes the post's UTMs cleanly", () => {
    const clean = stripTrackingParams("https://offers.hubspot.com/g?utm_source=youtube&utm_campaign=old");
    expect(applyPostUtms(clean, "x", "matg-x-oct")).toBe(
      "https://offers.hubspot.com/g?utm_source=x&utm_campaign=matg-x-oct",
    );
  });
});

describe("isHubSpotShortLink", () => {
  it("matches HubSpot shortener hosts only", () => {
    expect(isHubSpotShortLink("https://clickhubspot.com/cfmu")).toBe(true);
    expect(isHubSpotShortLink("https://hubs.ly/Q0abc")).toBe(true);
    expect(isHubSpotShortLink("https://offers.hubspot.com/guide")).toBe(false);
    expect(isHubSpotShortLink("not a url")).toBe(false);
  });
});

describe("parseOfferToolInput", () => {
  const description = "Free guide to automate your Instagram marketing with Muse AI: https://clickhubspot.com/cfmu\nMore…";

  it("returns the label without its trailing colon", () => {
    expect(
      parseOfferToolInput(
        { found: true, label: "Free guide to automate your Instagram marketing with Muse AI:", url: "https://clickhubspot.com/cfmu" },
        description,
      ),
    ).toEqual({ label: "Free guide to automate your Instagram marketing with Muse AI", url: "https://clickhubspot.com/cfmu" });
  });

  it("rejects a link that isn't actually in the description", () => {
    expect(parseOfferToolInput({ found: true, label: "Guide", url: "https://clickhubspot.com/zzzz" }, description)).toBeNull();
  });

  it("returns null when the model found no offer", () => {
    expect(parseOfferToolInput({ found: false }, description)).toBeNull();
  });
});

function redirect(location: string) {
  return new Response(null, { status: 301, headers: { location } });
}

describe("resolveRedirects", () => {
  it("follows multiple hops (incl. a relative Location) to the final page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://offers.hubspot.com/r"))
      .mockResolvedValueOnce(redirect("/guide?utm_source=youtube"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    expect(await resolveRedirects("https://clickhubspot.com/cfmu", fetchImpl as unknown as typeof fetch)).toEqual({
      ok: true,
      url: "https://offers.hubspot.com/guide?utm_source=youtube",
    });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("fails when it ends on a short-link host instead of the offer page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://hubs.ly/next"))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await resolveRedirects("https://clickhubspot.com/cfmu", fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "stuck-on-short-link",
    });
  });

  it("detects a redirect loop", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://offers.hubspot.com/a"))
      .mockResolvedValueOnce(redirect("https://clickhubspot.com/cfmu"));
    expect(await resolveRedirects("https://clickhubspot.com/cfmu", fetchImpl as unknown as typeof fetch)).toMatchObject({
      ok: false,
      reason: "too-many-hops",
    });
  });

  it("reports network errors / timeouts instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("The operation was aborted due to timeout"));
    expect(await resolveRedirects("https://clickhubspot.com/cfmu", fetchImpl as unknown as typeof fetch)).toMatchObject({
      ok: false,
      reason: "http-error",
    });
  });
});

describe("formatOfferCta", () => {
  it("puts the label line above the link", () => {
    expect(formatOfferCta({ label: "Free guide to X", url: "https://o.com/g?utm_source=x" })).toBe(
      "Free guide to X:\nhttps://o.com/g?utm_source=x",
    );
    expect(formatOfferCta({ label: null, url: "https://o.com" })).toBe("More here:\nhttps://o.com");
  });
});
