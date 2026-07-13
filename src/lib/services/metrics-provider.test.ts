import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapPulseToVideoDetail,
  mapPulseToTweet,
  mapPulseToPostMetrics,
  mapPulseToInstagramMetrics,
  creditsFor,
  fetchThreadsPostByUrl,
  fetchSingleVideo,
} from "./metrics-provider";
import type { PulsePostMetrics } from "./pulse-client";

const pulse = (overrides: Partial<PulsePostMetrics> = {}): PulsePostMetrics => ({
  url: "https://example.com/post",
  platform: "threads",
  contentId: "ABC123",
  postType: "threads",
  views: null,
  likes: 15,
  comments: 2,
  shares: 0,
  quotes: 0,
  bookmarks: null,
  viewsEstimated: false,
  commentsEstimated: false,
  publishedAt: "2026-07-13T02:42:07.000Z",
  title: "a post",
  author: "@someone",
  thumbnail: "https://cdn.example.com/t.jpg",
  fetchedAt: "2026-07-13T17:00:00.000Z",
  ...overrides,
});

describe("mapping: Pulse → SC shapes", () => {
  it("drops Pulse-estimated views so the hub's own estimator governs", () => {
    const m = mapPulseToPostMetrics(pulse({ views: 2250, viewsEstimated: true }));
    expect(m?.views).toBeNull();
    expect(m?.likes).toBe(15);
    expect(m?.comments).toBe(2);
    expect(m?.publishedAt).toBe("2026-07-13T02:42:07.000Z");
  });

  it("keeps real views", () => {
    const m = mapPulseToPostMetrics(pulse({ views: 9000, viewsEstimated: false }));
    expect(m?.views).toBe(9000);
  });

  it("returns null (→ SC fallback) when the answer carries no engagement at all", () => {
    expect(mapPulseToPostMetrics(pulse({ views: null, likes: null, comments: null }))).toBeNull();
    expect(
      // estimated views with no likes/comments is also unusable
      mapPulseToPostMetrics(pulse({ views: 100, viewsEstimated: true, likes: null, comments: null }))
    ).toBeNull();
  });

  it("youtube detail requires real views and maps count fields", () => {
    expect(mapPulseToVideoDetail(pulse({ views: null }))).toBeNull();
    const d = mapPulseToVideoDetail(
      pulse({ platform: "youtube", views: 1000, likes: 50, comments: 7, title: "vid" })
    );
    expect(d).toMatchObject({ viewCountInt: 1000, likeCountInt: 50, commentCountInt: 7, title: "vid" });
  });

  it("viewless X and reel answers defer to SC (views are the KPI)", () => {
    expect(mapPulseToTweet(pulse({ platform: "x", views: null, likes: 42 }))).toBeNull();
    expect(
      mapPulseToInstagramMetrics(pulse({ platform: "instagram", postType: "instagram_reel", views: 2000, viewsEstimated: true, likes: 9 }))
    ).toBeNull();
    // photo posts have no public views anywhere — likes-only is a full answer
    expect(
      mapPulseToInstagramMetrics(pulse({ platform: "instagram", postType: "instagram_post", views: 1233, viewsEstimated: true, likes: 9 }))
    ).toMatchObject({ views: null, likes: 9 });
  });

  it("tweet mapping reproduces the SCTweet nesting the decay branch reads", () => {
    const t = mapPulseToTweet(
      pulse({ platform: "x", views: 5000, likes: 42, comments: 3, publishedAt: "2026-07-01T00:00:00.000Z" })
    );
    expect(t?.views?.count).toBe("5000");
    expect(t?.legacy.favorite_count).toBe(42);
    expect(t?.legacy.reply_count).toBe(3);
    // decay does `new Date(created_at)` — the ISO string must parse
    expect(Number.isNaN(new Date(t!.legacy.created_at).getTime())).toBe(false);
  });

  it("instagram mapping carries shortcode + thumbnail", () => {
    const m = mapPulseToInstagramMetrics(pulse({ platform: "instagram", contentId: "SHORT1", views: 777 }));
    expect(m).toMatchObject({ shortcode: "SHORT1", views: 777, thumbnail: "https://cdn.example.com/t.jpg" });
  });
});

describe("credit accounting", () => {
  it("pulse answers are free, SC answers and not-found cost 1", () => {
    expect(creditsFor({ source: "pulse" })).toBe(0);
    expect(creditsFor({ source: "sc" })).toBe(1);
    expect(creditsFor(null)).toBe(1);
  });
});

describe("pulse-first fallback behavior", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("flag off (dark): Pulse is never contacted, SC serves", async () => {
    vi.stubEnv("PULSE_METRICS_ENABLED", "");
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ post: { like_count: 9, text_post_app_info: { direct_reply_count: 1 }, taken_at: 1780000000 } }),
        { status: 200 }
      );
    }) as typeof fetch;

    const result = await fetchThreadsPostByUrl("https://www.threads.net/@x/post/ABC");
    expect(result?.source).toBe("sc");
    expect(result?.likes).toBe(9);
    expect(calls.every((u) => u.includes("scrapecreators.com"))).toBe(true);
  });

  it("flag on: Pulse serves and SC is not called", async () => {
    vi.stubEnv("PULSE_METRICS_ENABLED", "1");
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(pulse()), { status: 200 });
    }) as typeof fetch;

    const result = await fetchThreadsPostByUrl("https://www.threads.net/@x/post/ABC");
    expect(result?.source).toBe("pulse");
    expect(result?.likes).toBe(15);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("pulse.walls.sh");
  });

  it("flag on + Pulse down: falls back to SC silently", async () => {
    vi.stubEnv("PULSE_METRICS_ENABLED", "1");
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("pulse.walls.sh")) {
        return new Response(JSON.stringify({ error: "rate_limited", detail: "cooling down" }), { status: 429 });
      }
      return new Response(
        JSON.stringify({ post: { like_count: 9, text_post_app_info: { direct_reply_count: 1 }, taken_at: 1780000000 } }),
        { status: 200 }
      );
    }) as typeof fetch;

    const result = await fetchThreadsPostByUrl("https://www.threads.net/@x/post/ABC");
    expect(result?.source).toBe("sc");
    expect(result?.likes).toBe(9);
  });

  it("flag on + Pulse says content gone: SC still gets the final word (404 → null)", async () => {
    vi.stubEnv("PULSE_METRICS_ENABLED", "1");
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("pulse.walls.sh")) {
        return new Response(JSON.stringify({ error: "content_unavailable", detail: "gone" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchThreadsPostByUrl("https://www.threads.net/@x/post/ABC");
    expect(result).toBeNull();
  });

  it("fetchSingleVideo keeps its throwing contract when both providers fail", async () => {
    vi.stubEnv("PULSE_METRICS_ENABLED", "1");
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(fetchSingleVideo("https://youtube.com/watch?v=abc")).rejects.toThrow();
  });
});
