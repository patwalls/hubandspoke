import { describe, it, expect } from "vitest";
import {
  canonicalFacebookPostUrl,
  derivePlatformContentId,
  isFacebookShareLink,
  looseUrlKey,
  parseLinkedInAccountInput,
} from "./platform-url";

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

  // Community links had no id before 2026-11-09, so the community sync pass
  // could only match the 196 Starter Story rows by loose URL — and the `?si=`
  // share links editors paste would never have matched the sync's clean URL.
  it("reads a YouTube community post id from both link shapes", () => {
    const id = "Ugkx-TbUFdDHy_8khcakLQSGo2zbJxGZOUfX";
    expect(
      derivePlatformContentId("youtube_community", `http://youtube.com/post/${id}?si=WwD8pkA6IzT72FCw`),
    ).toBe(id);
    expect(
      derivePlatformContentId(
        "youtube_community",
        `https://www.youtube.com/channel/UCabc/community?lb=${id}`,
      ),
    ).toBe(id);
  });

  it("still reads a video id from a youtube_community row that holds a Shorts link", () => {
    expect(
      derivePlatformContentId("youtube_community", "https://youtube.com/shorts/Ar8yKK2liUw"),
    ).toBe("Ar8yKK2liUw");
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

describe("Facebook share links", () => {
  it("recognizes a share link on any Facebook host, and nothing else", () => {
    expect(isFacebookShareLink("https://www.facebook.com/share/p/19igfL5kHn/")).toBe(true);
    expect(isFacebookShareLink("https://m.facebook.com/share/v/1CC7ehNLZx/")).toBe(true);
    expect(isFacebookShareLink("https://www.facebook.com/reel/123/")).toBe(false);
    expect(isFacebookShareLink("https://evil.example/share/p/abc/")).toBe(false);
    expect(isFacebookShareLink(null)).toBe(false);
  });

  it("reduces a redirect target to the exact link the account sync stores", () => {
    expect(
      canonicalFacebookPostUrl(
        "https://www.facebook.com/starterstoryofficial/posts/pfbid02LQ?rdid=abc&share_url=https%3A%2F%2Fx"
      )
    ).toBe("https://www.facebook.com/starterstoryofficial/posts/pfbid02LQ");
    expect(
      canonicalFacebookPostUrl("https://m.facebook.com/reel/2059793341393233/?rdid=abc")
    ).toBe("https://www.facebook.com/reel/2059793341393233/");
  });

  it("keeps the query param that names the post on php-style pages", () => {
    expect(
      canonicalFacebookPostUrl("https://www.facebook.com/photo.php?fbid=42&set=a.1&type=3")
    ).toBe("https://www.facebook.com/photo.php?fbid=42");
  });

  it("refuses anything that isn't a post, so a login wall never overwrites a link", () => {
    expect(canonicalFacebookPostUrl("https://www.facebook.com/login/?next=x")).toBeNull();
    expect(canonicalFacebookPostUrl("https://www.facebook.com/checkpoint/1501092823525282/")).toBeNull();
    expect(canonicalFacebookPostUrl("https://www.facebook.com/share/p/abc/")).toBeNull();
    expect(canonicalFacebookPostUrl("https://www.facebook.com/photo.php")).toBeNull();
    expect(canonicalFacebookPostUrl("https://evil.example/a/posts/1")).toBeNull();
  });

  it("looseUrlKey doesn't fold every Facebook photo into one key", () => {
    const a = looseUrlKey("https://www.facebook.com/photo.php?fbid=1&set=a.9");
    const b = looseUrlKey("https://www.facebook.com/photo.php?fbid=2&set=a.9");
    expect(a).not.toBe(b);
    expect(a).toBe(looseUrlKey("https://www.facebook.com/photo.php?fbid=1"));
  });
});
