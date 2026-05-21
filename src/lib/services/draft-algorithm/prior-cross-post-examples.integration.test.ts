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
    const olderSource = await createTestProductionItem({
      postType: "threads",
      contentBody: "Older Threads original.",
    });
    const olderTarget = await createTestProductionItem({
      postType: "x",
      sourceType: "cross_post",
      repostedFromItemId: olderSource.id,
      contentBody: "Older X cross-post.",
      publishedAt: new Date("2026-01-01T12:00:00Z"),
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
      publishedAt: new Date("2026-03-15T12:00:00Z"),
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
      publishedAt: new Date("2026-05-01T12:00:00Z"),
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
    expect(ours[0].targetPublishedAt).toBe("2026-05-01");
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

