import { describe, it, expect } from "vitest";
import { buildDestinationUrl } from "./tracked-cta";
import { renderCtaExemplars, CTA_EXEMPLARS } from "./cta-exemplars";

describe("buildDestinationUrl", () => {
  it("appends utm_source and utm_campaign with correct separators", () => {
    expect(
      buildDestinationUrl("https://starterstory.com/micro", "x", "ep-42"),
    ).toBe("https://starterstory.com/micro?utm_source=x&utm_campaign=ep-42");
  });

  it("omits utm_campaign when null or blank", () => {
    expect(
      buildDestinationUrl("https://starterstory.com/solo", "linkedin", null),
    ).toBe("https://starterstory.com/solo?utm_source=linkedin");
    expect(
      buildDestinationUrl("https://starterstory.com/solo", "linkedin", "  "),
    ).toBe("https://starterstory.com/solo?utm_source=linkedin");
  });

  it("preserves existing query params and uses & as separator", () => {
    const out = buildDestinationUrl(
      "https://starterstory.com/data/ideas?ref=abc",
      "threads",
      "spring",
    );
    expect(out).toContain("ref=abc");
    expect(out).toContain("utm_source=threads");
    expect(out).toContain("utm_campaign=spring");
    // never breaks the query string with a stray "/"
    expect(out).not.toContain("/utm_source");
  });

  it("overwrites a pre-existing utm_source rather than duplicating it", () => {
    const out = buildDestinationUrl(
      "https://starterstory.com/x?utm_source=old",
      "x",
      null,
    );
    expect(out).toBe("https://starterstory.com/x?utm_source=x");
  });

  it("falls back to manual append for a non-absolute target", () => {
    const out = buildDestinationUrl("/data/micro-saas-ideas", "x", "ep-1");
    expect(out).toBe("/data/micro-saas-ideas?utm_source=x&utm_campaign=ep-1");
  });
});

describe("renderCtaExemplars", () => {
  it("scopes to a single channel when given one", () => {
    const block = renderCtaExemplars("x");
    expect(block).toContain("[x ·");
    expect(block).not.toContain("[linkedin ·");
  });

  it("every exemplar copyLine ends with a colon (house style)", () => {
    for (const ex of CTA_EXEMPLARS) {
      expect(ex.copyLine.trim().endsWith(":")).toBe(true);
    }
  });
});
