import { describe, it, expect } from "vitest";
import {
  isForeignRetweet,
  normalizeLinkedInCompanyPost,
} from "./account-content-sync";
import type { SCTweet } from "./sc-fetchers";

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

// Regression for the tibo/saj_adib incident (2026-09): a retweet by
// @saj_adib of @thsottiaux was ingested as saj's own original post. SC
// dereferences a plain retweet to the ORIGINAL tweet, so the row carried
// tibo's tweet ID — and Twitter's embed widget resolves by ID (ignoring
// the handle in the URL), rendering tibo's tweet on a saj_adib page.
describe("isForeignRetweet", () => {
  function tweet(opts: {
    author?: string;
    fullText?: string;
  }): SCTweet {
    return {
      __typename: "Tweet",
      rest_id: "2089082893804896524",
      url: "https://x.com/saj_adib/status/2089082893804896524",
      legacy: {
        full_text: opts.fullText ?? "some tweet body",
        created_at: "Sun Aug 16 12:00:00 +0000 2026",
        favorite_count: 0,
        retweet_count: 0,
        reply_count: 0,
        bookmark_count: 0,
        id_str: "2089082893804896524",
      },
      core: opts.author
        ? { user_results: { result: { legacy: { screen_name: opts.author } } } }
        : undefined,
    };
  }

  it("skips a retweet of an account we don't own (author != synced handle)", () => {
    expect(isForeignRetweet(tweet({ author: "thsottiaux" }), "saj_adib")).toBe(
      true,
    );
  });

  it("keeps our own original post (author == synced handle)", () => {
    expect(isForeignRetweet(tweet({ author: "saj_adib" }), "saj_adib")).toBe(
      false,
    );
  });

  it("keeps a quote tweet — its top-level author is us, not the quoted account", () => {
    // A quote's body is our own commentary (no `RT @` prefix) and its
    // top-level author is the quoter.
    expect(
      isForeignRetweet(
        tweet({ author: "saj_adib", fullText: "this is a great point 👇" }),
        "saj_adib",
      ),
    ).toBe(false);
  });

  it("normalizes @ prefix and case when comparing handles", () => {
    expect(isForeignRetweet(tweet({ author: "Saj_Adib" }), "@saj_adib")).toBe(
      false,
    );
  });

  it("falls back to the RT @ marker when the author block is missing", () => {
    expect(
      isForeignRetweet(
        tweet({ fullText: "RT @thsottiaux: original tweet body" }),
        "saj_adib",
      ),
    ).toBe(true);
  });
});
