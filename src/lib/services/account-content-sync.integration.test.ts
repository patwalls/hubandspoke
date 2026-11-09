import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { createTestAccount, createTestProductionItem } from "@/test/factories";
import { SC_RETRY_DELAYS_MS, syncAccountContent } from "./account-content-sync";

describe("syncAccountContent — deleted accounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Regression: a deleted @matgpod row stayed is_active=true and kept syncing
  // daily, because the success path re-activates inactive accounts.
  it("is a no-op for an account deleted from the brand's account list", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("deleted account must not call Scrape Creators");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const acct = await createTestAccount({
      platform: "instagram",
      isActive: true,
      deletedAt: new Date(),
    });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.errorMessage).toBeUndefined();
    expect(result.pagesFetched).toBe(0);

    const [after] = await db
      .select({
        lastContentSyncAt: accounts.lastContentSyncAt,
        lastContentSyncError: accounts.lastContentSyncError,
      })
      .from(accounts)
      .where(eq(accounts.id, acct.id));
    expect(after.lastContentSyncAt).toBeNull();
    expect(after.lastContentSyncError).toBeNull();
  });
});

// Issue #139: ScrapeCreators 500s on ~15% of /v1/youtube/channel/shorts calls.
// One shorts 500 used to throw away the long-form page already fetched and
// fail the whole run until the next hourly sweep.
describe("syncAccountContent — YouTube shorts 5xx", () => {
  const savedDelays = [...SC_RETRY_DELAYS_MS];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, ...savedDelays);
  });

  function stubSc(shortsStatuses: number[]) {
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/v1/youtube/channel-videos") {
        return new Response(
          JSON.stringify({
            videos: [
              {
                id: `yt-long-${Date.now()}`,
                url: `https://www.youtube.com/watch?v=long${Date.now()}`,
                title: "Long one",
                publishedTime: "2026-11-01T12:00:00Z",
                viewCountInt: 100,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (path === "/v1/youtube/channel/shorts") {
        const status = shortsStatuses.shift() ?? 500;
        if (status !== 200) return new Response("upstream boom", { status });
        return new Response(JSON.stringify({ shorts: [] }), { status: 200 });
      }
      if (path === "/v1/youtube/channel/community-posts") {
        return new Response(JSON.stringify({ posts: [] }), { status: 200 });
      }
      throw new Error(`unexpected SC call ${path}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    return calls;
  }

  it("retries a one-off shorts 500 and the run succeeds", async () => {
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, 0, 0);
    const calls = stubSc([500, 200]);
    const acct = await createTestAccount({ platform: "youtube", isActive: true });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(result.errorMessage).toBeUndefined();
    expect(calls.filter((c) => c === "/v1/youtube/channel/shorts")).toHaveLength(2);
    expect(result.fetched).toBe(1);
  });

  it("keeps the long-form items when shorts stays 5xx, and still logs the error", async () => {
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, 0, 0);
    const calls = stubSc([500, 500, 500]);
    const acct = await createTestAccount({ platform: "youtube", isActive: true });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(calls.filter((c) => c === "/v1/youtube/channel/shorts")).toHaveLength(3);
    expect(result.fetched).toBe(1);
    expect(result.created + result.updated).toBe(1);
    expect(result.errorMessage).toMatch(/channel\/shorts 500/);
    expect(result.errorKind).toBe("transient");

    const [after] = await db
      .select({ isActive: accounts.isActive, err: accounts.lastContentSyncError })
      .from(accounts)
      .where(eq(accounts.id, acct.id));
    expect(after.isActive).toBe(true);
    expect(after.err).toMatch(/channel\/shorts 500/);
  });
});

// Community posts made straight on YouTube used to never get a row — the
// YouTube sync only had long + shorts passes. The third pass must add them
// AND match the ones Hub & Spoke already tracks, whose links editors paste
// as `youtube.com/post/<id>?si=…` (different from SC's clean URL).
describe("syncAccountContent — YouTube community posts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubSc(posts: unknown[] | "404") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/v1/youtube/channel-videos")
          return new Response(JSON.stringify({ videos: [] }), { status: 200 });
        if (path === "/v1/youtube/channel/shorts")
          return new Response(JSON.stringify({ shorts: [] }), { status: 200 });
        if (path === "/v1/youtube/channel/community-posts") {
          if (posts === "404") return new Response("not found", { status: 404 });
          return new Response(JSON.stringify({ posts }), { status: 200 });
        }
        throw new Error(`unexpected SC call ${path}`);
      })
    );
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
  }

  it("adds new community posts and updates the ones we already track", async () => {
    const acct = await createTestAccount({ platform: "youtube", isActive: true });
    const sfx = Date.now().toString(36);
    const trackedId = `UgkxTracked${sfx}`;
    const newId = `UgkxNew${sfx}`;
    const tracked = await createTestProductionItem({
      accountId: acct.id,
      postType: "youtube_community",
      platform: ["YouTube Community"],
      format: null,
      publishedLink: `http://youtube.com/post/${trackedId}?si=abc123`,
    });
    stubSc([
      {
        id: trackedId,
        url: `https://www.youtube.com/post/${trackedId}`,
        content: "Already in Hub & Spoke",
        likeCount: 40,
        publishedTime: "2026-11-01T12:00:00.000Z",
      },
      {
        id: newId,
        url: `https://www.youtube.com/post/${newId}`,
        content: "Posted straight on YouTube",
        images: ["https://yt3.ggpht.com/img.jpg"],
        likeCount: 10,
        publishedTime: "2026-11-02T12:00:00.000Z",
      },
    ]);

    try {
      const result = await syncAccountContent(acct.id, { mode: "latest" });
      expect(result.errorMessage).toBeUndefined();
      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);

      const rows = await db
        .select()
        .from(productionItems)
        .where(eq(productionItems.accountId, acct.id));
      expect(rows).toHaveLength(2);

      const [updated] = rows.filter((r) => r.id === tracked.id);
      expect(updated.likes).toBe(40);
      expect(updated.views).toBeGreaterThan(0); // estimated from likes
      expect(updated.viewsEstimated).toBe(true);

      const [added] = rows.filter((r) => r.id !== tracked.id);
      expect(added.postType).toBe("youtube_community");
      expect(added.platformContentId).toBe(newId);
      expect(added.format).toBeNull();
      expect(added.contentBody).toBe("Posted straight on YouTube");
      expect(added.thumbnail).toBe("https://yt3.ggpht.com/img.jpg");
      expect(added.publishedDate).toBe("2026-11-02");
    } finally {
      await db
        .delete(productionItems)
        .where(
          and(
            eq(productionItems.accountId, acct.id),
            ne(productionItems.id, tracked.id)
          )
        );
    }
  });

  it("treats a channel with no community tab (404) as empty, not a failure", async () => {
    const acct = await createTestAccount({ platform: "youtube", isActive: true });
    stubSc("404");
    const result = await syncAccountContent(acct.id, { mode: "latest" });
    expect(result.errorMessage).toBeUndefined();
    expect(result.fetched).toBe(0);
  });
});
