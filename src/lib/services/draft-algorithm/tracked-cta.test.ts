import { describe, it, expect } from "vitest";
import { buildDestinationUrl } from "./tracked-cta";
import { renderCtaExemplars, CTA_EXEMPLARS } from "./cta-exemplars";

describe("buildDestinationUrl", () => {
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it("uses the shared UTM rule with the post slug in utm_id", () => {
    expect(params(buildDestinationUrl("https://starterstory.com/micro", "instagram", "i-left-my-987"))).toEqual({
      utm_medium: "email-media-newsletter",
      utm_source: "starterstory",
      utm_campaign: "owned",
      utm_content: "Social",
      utm_term: "instagram",
      utm_id: "i-left-my-987",
    });
  });

  it("maps ytcommunity to the youtube platform in utm_term", () => {
    expect(params(buildDestinationUrl("https://starterstory.com/x", "ytcommunity", "ep-42")).utm_term).toBe("youtube");
  });

  it("omits utm_id when the post has no slug, keeps the rest", () => {
    for (const slug of [null, "  "]) {
      const p = params(buildDestinationUrl("https://starterstory.com/solo", "linkedin", slug));
      expect(p.utm_id).toBeUndefined();
      expect(p.utm_campaign).toBe("owned");
    }
  });

  it("preserves non-UTM query params and never uses / as a separator", () => {
    const out = buildDestinationUrl("https://starterstory.com/data/ideas?ref=abc", "threads", "spring");
    expect(params(out).ref).toBe("abc");
    expect(params(out).utm_id).toBe("spring");
    expect(out).not.toContain("/utm_");
  });

  it("replaces UTMs already on the target instead of mixing them in", () => {
    const p = params(buildDestinationUrl("https://starterstory.com/x?utm_source=old&utm_campaign=stale", "x", null));
    expect(p.utm_source).toBe("starterstory");
    expect(p.utm_campaign).toBe("owned");
  });

  it("falls back to manual append for a non-absolute target", () => {
    const out = buildDestinationUrl("/data/micro-saas-ideas", "x", "ep-1");
    expect(out.startsWith("/data/micro-saas-ideas?")).toBe(true);
    expect(out).toContain("utm_source=starterstory");
    expect(out).toContain("utm_id=ep-1");
  });
});

describe("renderCtaExemplars", () => {
  it("floats the requested channel's exemplars to the top but includes all", () => {
    const block = renderCtaExemplars("linkedin");
    expect(block).toContain("[linkedin ·");
    expect(block).toContain("[x ·"); // all channels still present
    // the first rendered exemplar is a linkedin one
    expect(block.indexOf("[linkedin ·")).toBeLessThan(block.indexOf("[x ·"));
  });

  it("includes an episode exemplar and lead-magnet exemplars", () => {
    const block = renderCtaExemplars();
    expect(block).toContain("target: episode");
    expect(block).toContain("target: lead_magnet");
  });

  it("every exemplar copyLine ends with a colon (house style)", () => {
    for (const ex of CTA_EXEMPLARS) {
      expect(ex.copyLine.trim().endsWith(":")).toBe(true);
    }
  });
});
