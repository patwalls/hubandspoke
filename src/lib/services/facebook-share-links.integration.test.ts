import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestAccount, createTestProductionItem } from "@/test/factories";
import { syncAccountContent } from "./account-content-sync";
import { MAX_SHARE_LINKS_PER_SYNC } from "./facebook-share-links";

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

function stubFacebook(opts: {
  redirects: Record<string, string | number>;
  posts: Array<Record<string, unknown>>;
}) {
  const shareCalls: string[] = [];
  vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url in opts.redirects) {
        shareCalls.push(url);
        const to = opts.redirects[url];
        return typeof to === "number"
          ? new Response(null, { status: to })
          : new Response(null, { status: 302, headers: { location: to } });
      }
      if (new URL(url).pathname === "/v1/facebook/profile/posts") {
        return new Response(JSON.stringify({ posts: opts.posts }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
  return shareCalls;
}

async function row(id: string) {
  const [r] = await db.select().from(productionItems).where(eq(productionItems.id, id));
  return r;
}

async function fbAccount() {
  return createTestAccount({
    platform: "facebook",
    url: "https://www.facebook.com/testpage",
    isActive: true,
  });
}

describe("syncAccountContent: Facebook posts saved with a share link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // The real prod shape, 2026-11-09: a cross-post saved as /share/p/… sat at
  // zero views while the sync made a second, format-less row for the same post.
  it("moves the views onto the saved post and retires the sync's duplicate", async () => {
    const acct = await fbAccount();
    const code = uniq();
    const share = `https://www.facebook.com/share/p/${code}/`;
    const canonical = `https://www.facebook.com/testpage/posts/pfbid${code}`;
    const saved = await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "api:cross-post",
      format: null,
      title: "The real title",
      publishedLink: share,
      platformContentId: null,
    });
    const twin = await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "sync:account-content",
      title: "Scraped caption",
      publishedLink: canonical,
      platformContentId: code,
      views: 1155,
      thumbnail: "https://img.example/twin.jpg",
    });
    stubFacebook({
      redirects: { [share]: `${canonical}?rdid=abc&share_url=x` },
      posts: [{ id: code, permalink: canonical, reactionCount: 10, commentCount: 2 }],
    });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(result.errorMessage).toBeUndefined();
    expect(result.created).toBe(0);
    const after = await row(saved.id);
    expect(after.publishedLink).toBe(canonical);
    expect(after.platformContentId).toBe(code);
    expect(after.title).toBe("The real title");
    expect(after.views).toBeGreaterThan(0);
    expect(after.likes).toBe(10);
    expect(after.comments).toBe(2);
    expect(after.thumbnail).toBe("https://img.example/twin.jpg");
    expect((await row(twin.id)).deletedAt).not.toBeNull();
  });

  it("matches a share link before the sync can add a duplicate of it", async () => {
    const acct = await fbAccount();
    const code = uniq();
    const share = `https://www.facebook.com/share/v/${code}/`;
    const canonical = `https://www.facebook.com/reel/${code}/`;
    const saved = await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "api:cross-post",
      publishedLink: share,
      platformContentId: null,
    });
    stubFacebook({
      redirects: { [share]: canonical },
      posts: [{ id: `fb${code}`, permalink: canonical, reactionCount: 3, videoViewCount: 77 }],
    });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    const after = await row(saved.id);
    expect(after.publishedLink).toBe(canonical);
    expect(after.views).toBe(77);
  });

  it("leaves the row alone when the link can't be resolved, and still syncs", async () => {
    const acct = await fbAccount();
    const code = uniq();
    const dead = `https://www.facebook.com/share/p/${code}/`;
    const walled = `https://www.facebook.com/share/p/w${code}/`;
    const a = await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "api:cross-post",
      publishedLink: dead,
      platformContentId: null,
    });
    const b = await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "api:cross-post",
      publishedLink: walled,
      platformContentId: null,
    });
    stubFacebook({
      redirects: { [dead]: 404, [walled]: "https://www.facebook.com/login/?next=x" },
      posts: [],
    });

    const result = await syncAccountContent(acct.id, { mode: "latest" });

    expect(result.errorMessage).toBeUndefined();
    expect((await row(a.id)).publishedLink).toBe(dead);
    expect((await row(b.id)).publishedLink).toBe(walled);
  });

  it("never absorbs a row a person made, only one the sync made", async () => {
    const acct = await fbAccount();
    const code = uniq();
    const share = `https://www.facebook.com/share/p/${code}/`;
    const canonical = `https://www.facebook.com/testpage/posts/pfbid${code}`;
    await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "api:cross-post",
      publishedLink: share,
      platformContentId: null,
    });
    const human = await createTestProductionItem({
      accountId: acct.id,
      postType: "facebook_post",
      createdVia: "api:cross-post",
      publishedLink: canonical,
      platformContentId: null,
    });
    stubFacebook({ redirects: { [share]: canonical }, posts: [] });

    await syncAccountContent(acct.id, { mode: "latest" });

    expect((await row(human.id)).deletedAt).toBeNull();
  });

  it("caps the share links one sync will look up", async () => {
    const acct = await fbAccount();
    const redirects: Record<string, number> = {};
    for (let i = 0; i <= MAX_SHARE_LINKS_PER_SYNC; i++) {
      const link = `https://www.facebook.com/share/p/${uniq()}x${i}/`;
      redirects[link] = 404;
      await createTestProductionItem({
        accountId: acct.id,
        postType: "facebook_post",
        createdVia: "api:cross-post",
        publishedLink: link,
        platformContentId: null,
      });
    }
    const calls = stubFacebook({ redirects, posts: [] });

    await syncAccountContent(acct.id, { mode: "latest" });

    expect(calls).toHaveLength(MAX_SHARE_LINKS_PER_SYNC);
  });
});
