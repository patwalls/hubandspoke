import { describe, expect, it } from "vitest";
import {
  createTestProductionItem,
  getTestAccountId,
} from "@/test/factories";
import { loadPriorCrossPostExamples } from "./prior-cross-post-examples";

describe("loadPriorCrossPostExamples", () => {
  it("returns the team's last N published (source → target) pairs for one account, newest first", async () => {
    const accountId = await getTestAccountId();

    // Three published Threads → X cross-post pairs at strictly different
    // publish times — confirms the ORDER BY desc(publishedAt) sort.
    // Dates chosen to all sit within the v1.9 45-day recency window
    // (now() - 5d / 15d / 30d). Test asserts ordering, which is
    // independent of the window — the dates just need to fit.
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000);

    const olderSource = await createTestProductionItem({
      postType: "threads",
      contentBody: "Older Threads original.",
    });
    const olderTarget = await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: olderSource.id,
      contentBody: "Older X cross-post.",
      publishedAt: ago(30),
      accountId,
    });

    const midSource = await createTestProductionItem({
      postType: "threads",
      contentBody: "Mid Threads original.",
    });
    const midTarget = await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: midSource.id,
      contentBody: "Mid X cross-post.",
      publishedAt: ago(15),
      accountId,
    });

    const newerSource = await createTestProductionItem({
      postType: "threads",
      contentBody: "Newer Threads original.",
    });
    const newerTarget = await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: newerSource.id,
      contentBody: "Newer X cross-post.",
      publishedAt: ago(5),
      accountId,
    });

    // Touch the fixture references so tsc doesn't strip them — and as a
    // defensive check that the rows actually inserted.
    expect(olderTarget.id).toBeTruthy();
    expect(midTarget.id).toBeTruthy();
    expect(newerTarget.id).toBeTruthy();

    const examples = await loadPriorCrossPostExamples({
      accountId,
      sourcePostType: "threads",
      targetPostType: "x",
      limit: 10,
    });

    // Filter to only the rows this test inserted (the dev DB may have
    // other Published threads→x cross-posts from real syncs or other
    // fixtures). Asserting the *ordering* of OUR rows is the
    // regression-worthy contract.
    const ours = examples.filter((e) =>
      [
        olderSource.contentBody,
        midSource.contentBody,
        newerSource.contentBody,
      ].includes(e.sourceText),
    );
    expect(ours).toHaveLength(3);
    expect(ours.map((e) => e.sourceText)).toEqual([
      "Newer Threads original.",
      "Mid Threads original.",
      "Older Threads original.",
    ]);
    expect(ours[0].targetText).toBe("Newer X cross-post.");
    expect(ours[0].targetPublishedAt).toBe(
      ago(5).toISOString().slice(0, 10),
    );
  });

  it("falls back to all-time when the 45d recency window is empty (v1.9)", async () => {
    const accountId = await getTestAccountId();
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000);

    // One stale pair on a never-recently-used direction. instagram_story
    // → linkedin is unlikely to appear in real dev data — keeps the
    // assertion isolated to our fixture.
    const staleSource = await createTestProductionItem({
      postType: "instagram_story",
      contentBody: "Stale IG Story source.",
    });
    await createTestProductionItem({
      postType: "linkedin",
      sourceType: "cross_post",
      repostedFromItemId: staleSource.id,
      contentBody: "Stale LinkedIn cross-post.",
      // 120 days back — well outside the 45-day window.
      publishedAt: ago(120),
      accountId,
    });

    const examples = await loadPriorCrossPostExamples({
      accountId,
      sourcePostType: "instagram_story",
      targetPostType: "linkedin",
      limit: 3,
    });

    // Window returned 0 → fallback kicks in → stale pair surfaces anyway.
    // Better stale examples than nothing (the v13 failure mode was leaving
    // the agent with only the proximity directive).
    const ours = examples.filter(
      (e) => e.sourceText === "Stale IG Story source.",
    );
    expect(ours).toHaveLength(1);
    expect(ours[0].targetText).toBe("Stale LinkedIn cross-post.");
  });

  it("excludes cross-posts on a different account", async () => {
    const myAccountId = await getTestAccountId();
    const otherAccountId = await getTestAccountId({
      platform: "linkedin",
    });

    const source = await createTestProductionItem({
      postType: "threads",
      contentBody: "Other-brand source — should not appear.",
    });
    await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      contentBody: "Other-brand target — should not appear.",
      accountId: otherAccountId,
    });

    const examples = await loadPriorCrossPostExamples({
      accountId: myAccountId,
      sourcePostType: "threads",
      targetPostType: "x",
    });
    expect(
      examples.find((e) => e.sourceText.includes("Other-brand source")),
    ).toBeUndefined();
  });

  it("excludes non-published targets and cross_post-source rows", async () => {
    const accountId = await getTestAccountId();
    const source = await createTestProductionItem({
      postType: "threads",
      contentBody: "Source for unpublished target.",
    });
    await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      contentBody: "Draft, not yet published.",
      status: "Ready To Publish",
      accountId,
    });

    // A 'repost' (not cross_post) target — should also be excluded.
    const repostSource = await createTestProductionItem({
      postType: "threads",
      contentBody: "Source for repost.",
    });
    await createTestProductionItem({
      postType: "x",
      sourceType: "repost",
      repostedFromItemId: repostSource.id,
      contentBody: "Repost (same content), not a cross_post.",
      accountId,
    });

    const examples = await loadPriorCrossPostExamples({
      accountId,
      sourcePostType: "threads",
      targetPostType: "x",
    });
    expect(
      examples.find((e) =>
        e.targetText.includes("Draft, not yet published."),
      ),
    ).toBeUndefined();
    expect(
      examples.find((e) =>
        e.targetText.includes("Repost (same content)"),
      ),
    ).toBeUndefined();
  });

  it("returns [] when sourcePostType or targetPostType is null", async () => {
    const accountId = await getTestAccountId();
    expect(
      await loadPriorCrossPostExamples({
        accountId,
        sourcePostType: null,
        targetPostType: "x",
      }),
    ).toEqual([]);
    expect(
      await loadPriorCrossPostExamples({
        accountId,
        sourcePostType: "threads",
        targetPostType: null,
      }),
    ).toEqual([]);
  });
});

