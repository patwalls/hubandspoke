import { describe, it, expect } from "vitest";
import { derivePlatformContentId, parseLinkedInAccountInput } from "./platform-url";

describe("parseLinkedInAccountInput", () => {
  it("parses a full company URL into slug + canonical company url", () => {
    const r = parseLinkedInAccountInput(
      "https://www.linkedin.com/company/hubspot/"
    );
    expect(r).toEqual({
      ok: true,
      handle: "hubspot",
      url: "https://www.linkedin.com/company/hubspot",
      kind: "company",
    });
  });

  it("takes the slug from an admin dashboard URL", () => {
    const r = parseLinkedInAccountInput(
      "https://www.linkedin.com/company/starter-story/admin/dashboard/"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.handle).toBe("starter-story");
      expect(r.url).toBe("https://www.linkedin.com/company/starter-story");
      expect(r.kind).toBe("company");
    }
  });

  it("rejects numeric company IDs with a slug hint", () => {
    const r = parseLinkedInAccountInput(
      "https://www.linkedin.com/company/27061078/admin/dashboard/"
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/numeric company IDs/i);
      expect(r.error).toMatch(/vanity URL/i);
    }
  });

  it("rejects a bare numeric company path too", () => {
    const r = parseLinkedInAccountInput("company/27061078");
    expect(r.ok).toBe(false);
  });

  it("parses a personal profile URL", () => {
    const r = parseLinkedInAccountInput(
      "https://www.linkedin.com/in/patrickwalls"
    );
    expect(r).toEqual({
      ok: true,
      handle: "patrickwalls",
      url: "https://www.linkedin.com/in/patrickwalls",
      kind: "personal",
    });
  });

  it("strips query strings and trailing path from the slug", () => {
    const r = parseLinkedInAccountInput(
      "https://www.linkedin.com/company/hubspot/posts/?feedView=all"
    );
    expect(r.ok && r.handle).toBe("hubspot");
  });

  it("leaves a bare handle as-is with a null url", () => {
    const r = parseLinkedInAccountInput("@some-handle");
    expect(r).toEqual({
      ok: true,
      handle: "some-handle",
      url: null,
      kind: "bare",
    });
  });

  it("errors on empty input", () => {
    expect(parseLinkedInAccountInput("   ").ok).toBe(false);
  });
});

describe("derivePlatformContentId", () => {
  it("reads the id with the post type's shape", () => {
    expect(
      derivePlatformContentId("instagram_reel", "https://www.instagram.com/reel/ABC123/?igsh=x"),
    ).toBe("ABC123");
  });

  it("falls back to the host when the post type isn't set", () => {
    expect(derivePlatformContentId(null, "https://x.com/someone/status/1234567890")).toBe(
      "1234567890",
    );
  });

  it("is null for a link it can't read, or no link", () => {
    expect(derivePlatformContentId("newsletter", "https://example.com/issue-12")).toBeNull();
    expect(derivePlatformContentId("instagram_reel", null)).toBeNull();
  });
});
