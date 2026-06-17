import { describe, it, expect } from "vitest";
import { normalizeLinkedInCompanyPost } from "./account-content-sync";

// Real shape returned by `/v1/linkedin/company/posts` (verified live 2026-06-17
// against linkedin.com/company/starterstory123 and /shopify): lean post objects
// of exactly `{ url, id, datePublished, text }`. The previous mapping keyed the
// dedup id on `activity_urn`/`urn` and the date on `posted_at.timestamp` — none
// of which are present — so every post was dropped. These tests pin the fix.
describe("normalizeLinkedInCompanyPost", () => {
  const live = {
    url: "https://www.linkedin.com/posts/starterstory123_lovable-hit-500m-activity-7473080057280786432-AtPv",
    id: "7473080057280786432",
    datePublished: "2026-06-17T18:32:08.732Z",
    text: "> Lovable hit $500M in June.\n> Cursor got acquired for $60B.",
  };

  it("maps the live lean payload (no urn / posted_at / stats)", () => {
    const item = normalizeLinkedInCompanyPost(live);
    expect(item).not.toBeNull();
    expect(item!.platformContentId).toBe("7473080057280786432");
    expect(item!.publishedLink).toBe(live.url);
    expect(item!.postType).toBe("linkedin");
    expect(item!.publishedAt?.toISOString()).toBe("2026-06-17T18:32:08.732Z");
    expect(item!.publishedDate).toBe("2026-06-17");
    expect(item!.contentBody).toBe(live.text);
    expect(item!.contentBodySource).toBe("scrape_creators");
    // Engagement + thumbnail aren't in the payload — must be null, not 0.
    expect(item!.views).toBeNull();
    expect(item!.likes).toBeNull();
    expect(item!.comments).toBeNull();
    expect(item!.thumbnail).toBeNull();
  });

  it("derives the content id from the URL when `id` is absent", () => {
    const item = normalizeLinkedInCompanyPost({
      url: live.url,
      datePublished: live.datePublished,
      text: live.text,
    });
    // extractContentId pulls 7473080057280786432 from `activity-<id>` in the
    // URL — must match the id-sourced key so dedup is stable across sources.
    expect(item!.platformContentId).toBe("7473080057280786432");
  });

  it("still maps the legacy rich shape (urn + posted_at + stats + images)", () => {
    const item = normalizeLinkedInCompanyPost({
      urn: "urn:li:activity:123",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
      text: "legacy",
      posted_at: { timestamp: 1_700_000_000_000 },
      stats: { total_reactions: 42, comments: 7 },
      images: [{ url: "https://img.example/x.jpg" }],
    });
    expect(item!.platformContentId).toBe("urn:li:activity:123");
    expect(item!.likes).toBe(42);
    expect(item!.comments).toBe(7);
    expect(item!.thumbnail).toBe("https://img.example/x.jpg");
    expect(item!.publishedAt?.getTime()).toBe(1_700_000_000_000);
  });

  it("returns null when there is no url", () => {
    expect(normalizeLinkedInCompanyPost({ id: "1", text: "x" })).toBeNull();
  });

  it("returns null when no id can be derived", () => {
    expect(
      normalizeLinkedInCompanyPost({ url: "https://example.com/no-activity" })
    ).toBeNull();
  });

  it("falls back to '(No caption)' and null date on an empty post", () => {
    const item = normalizeLinkedInCompanyPost({ url: live.url });
    expect(item!.title).toBe("(No caption)");
    expect(item!.contentBody).toBeNull();
    expect(item!.publishedAt).toBeNull();
    expect(item!.publishedDate).toBeNull();
  });
});
