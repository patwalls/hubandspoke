import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, scheduledMatchSuggestions } from "@/lib/db/schema";
import {
  createTestAccount,
  createTestProductionItem,
} from "@/test/factories";
import {
  loadMatchCandidates,
  findBestScheduledMatch,
  type ScheduledItemForMatch,
} from "./matcher";
import { runScheduleReconcile, runScheduleNodateReconcile } from "./reconcile";

const HOUR = 60 * 60 * 1000;

// Minimal OpenAI stand-in: returns a single forced return_match tool call.
function stubClient(matchIndex: number, confidence: number, reason = "stub") {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "return_match",
                      arguments: JSON.stringify({
                        match_index: matchIndex,
                        confidence,
                        reason,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    },
  } as never;
}

async function scheduledItemForMatch(
  id: string,
): Promise<ScheduledItemForMatch> {
  const [row] = await db
    .select({
      id: productionItems.id,
      accountId: productionItems.accountId,
      postType: productionItems.postType,
      title: productionItems.title,
      hook: productionItems.hook,
      contentBody: productionItems.contentBody,
      scheduledAt: productionItems.scheduledAt,
      expectedPublishAt: productionItems.expectedPublishAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  return {
    id: row.id,
    accountId: row.accountId!,
    postType: row.postType,
    title: row.title,
    hook: row.hook,
    contentBody: row.contentBody,
    scheduledAt: row.scheduledAt!,
    expectedPublishAt: row.expectedPublishAt,
  };
}

describe("loadMatchCandidates (structural gate)", () => {
  it("returns only same-account, in-window, synced-origin, matching-post_type Published rows", async () => {
    const acct = await createTestAccount();
    const other = await createTestAccount();
    const now = new Date();

    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      publishedAt: null,
      publishedDate: null,
    });

    const good = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: new Date(now.getTime() - 5 * 60 * 1000),
    });

    // Excluded for various reasons:
    await createTestProductionItem({
      accountId: other.id, // wrong account
      status: "Published",
      postType: "x",
      publishedAt: now,
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: new Date(now.getTime() - 72 * HOUR), // before window
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "youtube_long", // wrong post_type
      publishedAt: now,
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      sourceType: "repost", // not synced-origin
      publishedAt: now,
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled", // not Published
      postType: "x",
      publishedAt: now,
    });

    const candidates = await loadMatchCandidates(
      await scheduledItemForMatch(sched.id),
    );
    expect(candidates.map((c) => c.id)).toEqual([good.id]);
  });
});

describe("findBestScheduledMatch (LLM mapping)", () => {
  it("maps a chosen index to the candidate + clamped score", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      publishedAt: null,
      publishedDate: null,
      hook: "the same hook",
    });
    const cand = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: now,
      hook: "the same hook",
    });

    const res = await findBestScheduledMatch(
      await scheduledItemForMatch(sched.id),
      { client: stubClient(1, 92) },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value?.candidateId).toBe(cand.id);
      expect(res.value?.score).toBe(92);
    }
  });

  it("returns null when the model reports no match (index 0)", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      publishedAt: null,
      publishedDate: null,
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: now,
    });

    const res = await findBestScheduledMatch(
      await scheduledItemForMatch(sched.id),
      { client: stubClient(0, 0) },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });
});

describe("runScheduleReconcile tier policy", () => {
  it("auto-merges a ≥85 match: Scheduled item becomes Published, synced row absorbed", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      publishedAt: null,
      publishedDate: null,
      title: "my planned post",
      hook: "planned hook",
    });
    const synced = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: now,
      publishedLink: "https://x.com/test/status/123",
      platformContentId: `vitest-pcid-${now.getTime()}`,
      thumbnail: "https://cdn/thumb.jpg",
    });

    const summary = await runScheduleReconcile({
      client: stubClient(1, 95),
      onlyItemIds: [sched.id],
    });
    expect(summary.autoMerged).toBe(1);

    const [keeper] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(keeper.status).toBe("Published");
    expect(keeper.publishedLink).toBe("https://x.com/test/status/123");
    expect(keeper.platformContentId).toBe(synced.platformContentId);
    expect(keeper.thumbnail).toBe("https://cdn/thumb.jpg");

    const [absorbed] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, synced.id));
    expect(absorbed.deletedAt).not.toBeNull();
  });

  it("writes a pending suggestion for a 55–84 match (no merge)", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      publishedAt: null,
      publishedDate: null,
    });
    const cand = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: now,
    });

    const summary = await runScheduleReconcile({
      client: stubClient(1, 70),
      onlyItemIds: [sched.id],
    });
    expect(summary.suggested).toBe(1);
    expect(summary.autoMerged).toBe(0);

    const rows = await db
      .select()
      .from(scheduledMatchSuggestions)
      .where(
        and(
          eq(scheduledMatchSuggestions.scheduledItemId, sched.id),
          eq(scheduledMatchSuggestions.candidateItemId, cand.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].score).toBe(70);

    // Item stays Scheduled.
    const [still] = await db
      .select({ status: productionItems.status })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(still.status).toBe("Scheduled");

    // Cleanup the suggestion (not factory-tracked; cascade would also handle
    // it when the items are deleted, but be explicit).
    await db
      .delete(scheduledMatchSuggestions)
      .where(eq(scheduledMatchSuggestions.id, rows[0].id));
  });

  it("does nothing for a <55 match", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      publishedAt: null,
      publishedDate: null,
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "x",
      publishedAt: now,
    });

    const summary = await runScheduleReconcile({
      client: stubClient(1, 30),
      onlyItemIds: [sched.id],
    });
    expect(summary.autoMerged).toBe(0);
    expect(summary.suggested).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("flags needs-attention per post_type window (TikTok 24h, YouTube long 48h)", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const at30h = new Date(now.getTime() - 30 * HOUR);

    // TikTok (fast, 24h window) scheduled 30h ago → give up.
    const fast = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "tiktok",
      scheduledAt: at30h,
      publishedAt: null,
      publishedDate: null,
    });
    // YouTube long (slow, 48h window) scheduled 30h ago → still matching.
    const slow = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "youtube_long",
      scheduledAt: at30h,
      publishedAt: null,
      publishedDate: null,
    });

    const summary = await runScheduleReconcile({
      client: stubClient(0, 0), // no candidates anyway
      onlyItemIds: [fast.id, slow.id],
    });
    expect(summary.gaveUp).toBe(1);

    const [fastRow] = await db
      .select({ na: productionItems.scheduleNeedsAttentionAt })
      .from(productionItems)
      .where(eq(productionItems.id, fast.id));
    expect(fastRow.na).not.toBeNull();

    const [slowRow] = await db
      .select({ na: productionItems.scheduleNeedsAttentionAt })
      .from(productionItems)
      .where(eq(productionItems.id, slow.id));
    expect(slowRow.na).toBeNull();
  });
});

describe("runScheduleReconcile — no-date item exclusion", () => {
  it("skips items with scheduledNoDate=true (leaves them for the nodate sweep)", async () => {
    const acct = await createTestAccount();
    const now = new Date();

    // A no-date scheduled item — should be invisible to the date sweep.
    const noDateItem = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "youtube_long",
      scheduledAt: now,
      scheduledNoDate: true,
      publishedAt: null,
      publishedDate: null,
    });
    // A candidate that would match if the sweep ran.
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "youtube_long",
      publishedAt: now,
    });

    const summary = await runScheduleReconcile({
      client: stubClient(1, 95),
      onlyItemIds: [noDateItem.id],
    });
    // The date sweep must not have touched the no-date item.
    expect(summary.considered).toBe(0);
    expect(summary.autoMerged).toBe(0);

    const [row] = await db
      .select({ status: productionItems.status })
      .from(productionItems)
      .where(eq(productionItems.id, noDateItem.id));
    expect(row.status).toBe("Scheduled");
  });
});

describe("runScheduleNodateReconcile", () => {
  it("auto-merges a no-date item when a confident match is found", async () => {
    const acct = await createTestAccount();
    const now = new Date();

    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "youtube_long",
      scheduledAt: now,
      scheduledNoDate: true,
      publishedAt: null,
      publishedDate: null,
      title: "my youtube video",
    });
    const synced = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "youtube_long",
      publishedAt: now,
      publishedLink: "https://youtu.be/abc123",
      platformContentId: `vitest-nodate-pcid-${now.getTime()}`,
    });

    const summary = await runScheduleNodateReconcile({
      client: stubClient(1, 90),
      onlyItemIds: [sched.id],
    });
    expect(summary.autoMerged).toBe(1);

    const [keeper] = await db
      .select({ status: productionItems.status, link: productionItems.publishedLink })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(keeper.status).toBe("Published");
    expect(keeper.link).toBe("https://youtu.be/abc123");

    const [absorbed] = await db
      .select({ deletedAt: productionItems.deletedAt })
      .from(productionItems)
      .where(eq(productionItems.id, synced.id));
    expect(absorbed.deletedAt).not.toBeNull();
  });

  it("does not give up a no-date item after 48h (still within 14-day window)", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const at50h = new Date(now.getTime() - 50 * HOUR);

    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "youtube_long",
      scheduledAt: at50h,
      scheduledNoDate: true,
      publishedAt: null,
      publishedDate: null,
    });

    const summary = await runScheduleNodateReconcile({
      client: stubClient(0, 0),
      onlyItemIds: [sched.id],
    });
    expect(summary.gaveUp).toBe(0);

    const [row] = await db
      .select({ na: productionItems.scheduleNeedsAttentionAt })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(row.na).toBeNull();
  });

  it("gives up a no-date item after 14 days and flags needs-attention", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    const at15days = new Date(now.getTime() - 15 * 24 * HOUR);

    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "youtube_long",
      scheduledAt: at15days,
      scheduledNoDate: true,
      publishedAt: null,
      publishedDate: null,
    });

    const summary = await runScheduleNodateReconcile({
      client: stubClient(0, 0),
      onlyItemIds: [sched.id],
    });
    expect(summary.gaveUp).toBe(1);

    const [row] = await db
      .select({ na: productionItems.scheduleNeedsAttentionAt })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(row.na).not.toBeNull();
  });
});
