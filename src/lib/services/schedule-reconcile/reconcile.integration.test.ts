import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems, scheduledMatchSuggestions } from "@/lib/db/schema";
import {
  createTestAccount,
  createTestProductionItem,
} from "@/test/factories";
import {
  loadMatchCandidates,
  findBestScheduledMatch,
  type ScheduledItemForMatch,
} from "./matcher";
import {
  runScheduleReconcile,
  runScheduleNodateReconcile,
  selectAccountsForScheduleSync,
} from "./reconcile";

const HOUR = 60 * 60 * 1000;

// Minimal Anthropic stand-in: returns a single forced return_match tool call.
function stubClient(matchIndex: number, confidence: number, reason = "stub") {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: "tool_use",
            name: "return_match",
            input: { match_index: matchIndex, confidence, reason },
          },
        ],
      }),
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

  it("measures the give-up window from expectedPublishAt, not scheduledAt, when both are set", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    // Operator batch-scheduled this Reel 3 days ago (scheduledAt), but told
    // the system it isn't expected to go live until 2h from now. The old
    // scheduledAt-only clock would have given up on this already.
    const scheduledAt = new Date(now.getTime() - 72 * HOUR);
    const expectedPublishAt = new Date(now.getTime() + 2 * HOUR);

    const item = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "instagram_reel", // fast, 24h window
      scheduledAt,
      expectedPublishAt,
      publishedAt: null,
      publishedDate: null,
    });

    const summary = await runScheduleReconcile({
      client: stubClient(0, 0), // no candidates anyway
      onlyItemIds: [item.id],
    });
    expect(summary.gaveUp).toBe(0);

    const [row] = await db
      .select({ na: productionItems.scheduleNeedsAttentionAt })
      .from(productionItems)
      .where(eq(productionItems.id, item.id));
    expect(row.na).toBeNull();
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

describe("selectAccountsForScheduleSync (targeted-freshness gate)", () => {
  it("skips an account whose only pending item's expected date is still days away", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      expectedPublishAt: new Date(now.getTime() + 2 * 24 * HOUR),
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).not.toContain(acct.id);
  });

  it("includes an account whose pending item has no expected date, regardless of last sync", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    await db
      .update(accounts)
      .set({ lastContentSyncAt: now })
      .where(eq(accounts.id, acct.id));
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: now,
      expectedPublishAt: null,
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).toContain(acct.id);
  });

  it("includes an account whose item's expected date has arrived and it has never been synced", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: new Date(now.getTime() - HOUR),
      expectedPublishAt: new Date(now.getTime() - 5 * 60 * 1000),
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).toContain(acct.id);
  });

  it("throttles an account whose due item was already synced within the last 30 min", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    await db
      .update(accounts)
      .set({ lastContentSyncAt: new Date(now.getTime() - 10 * 60 * 1000) })
      .where(eq(accounts.id, acct.id));
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: new Date(now.getTime() - HOUR),
      expectedPublishAt: new Date(now.getTime() - 5 * 60 * 1000),
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).not.toContain(acct.id);
  });

  it("re-includes a throttled account once the throttle window has elapsed", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    await db
      .update(accounts)
      .set({ lastContentSyncAt: new Date(now.getTime() - 45 * 60 * 1000) })
      .where(eq(accounts.id, acct.id));
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "x",
      scheduledAt: new Date(now.getTime() - HOUR),
      expectedPublishAt: new Date(now.getTime() - 5 * 60 * 1000),
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).toContain(acct.id);
  });

  it("keeps syncing a flagged (needs-attention) item's account while within the abandon horizon", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    // Flagged 5 days ago, scheduled 6 days ago, no expected date → still
    // within the 14-day abandon horizon, so its account must keep syncing.
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "instagram_reel",
      scheduledAt: new Date(now.getTime() - 6 * 24 * HOUR),
      expectedPublishAt: null,
      scheduleNeedsAttentionAt: new Date(now.getTime() - 5 * 24 * HOUR),
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).toContain(acct.id);
  });

  it("stops syncing an item's account once it is past the abandon horizon", async () => {
    const acct = await createTestAccount();
    const now = new Date();
    await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "instagram_reel",
      scheduledAt: new Date(now.getTime() - 15 * 24 * HOUR),
      expectedPublishAt: null,
      scheduleNeedsAttentionAt: new Date(now.getTime() - 14 * 24 * HOUR),
      publishedAt: null,
      publishedDate: null,
    });

    const ids = await selectAccountsForScheduleSync(now);
    expect(ids).not.toContain(acct.id);
  });
});

describe("runScheduleReconcile — needs-attention is not terminal", () => {
  it("still auto-merges a flagged item when its go-live finally appears (the reported bug)", async () => {
    const acct = await createTestAccount();
    const now = new Date();

    // A Reel marked Scheduled 30h ago (past its 24h window) with no live post
    // yet — exactly the case that was permanently lost before.
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "instagram_reel",
      scheduledAt: new Date(now.getTime() - 30 * HOUR),
      expectedPublishAt: null,
      publishedAt: null,
      publishedDate: null,
      title: "HubSpot lost 140 million visits but grew leads 20%",
    });

    // First sweep, no candidate exists yet → it surfaces to Needs-attention
    // but is NOT abandoned.
    const first = await runScheduleReconcile({
      client: stubClient(0, 0),
      onlyItemIds: [sched.id],
    });
    expect(first.gaveUp).toBe(1);
    const [afterFirst] = await db
      .select({
        na: productionItems.scheduleNeedsAttentionAt,
        status: productionItems.status,
      })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(afterFirst.na).not.toBeNull();
    expect(afterFirst.status).toBe("Scheduled");

    // The post actually goes live a day later; the sync pulls it in.
    const live = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "instagram_reel",
      publishedAt: now,
      publishedLink: "https://instagram.com/reel/late-golive",
      platformContentId: `vitest-late-golive-${now.getTime()}`,
      title: "HubSpot lost 140 million visits in a year but grew leads 20%",
    });

    // Second sweep: the flagged item must still be considered and auto-merge.
    const second = await runScheduleReconcile({
      client: stubClient(1, 95),
      onlyItemIds: [sched.id],
    });
    expect(second.considered).toBe(1);
    expect(second.autoMerged).toBe(1);

    const [afterSecond] = await db
      .select({ status: productionItems.status, link: productionItems.publishedLink })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(afterSecond.status).toBe("Published");
    expect(afterSecond.link).toBe("https://instagram.com/reel/late-golive");

    const [absorbed] = await db
      .select({ deletedAt: productionItems.deletedAt })
      .from(productionItems)
      .where(eq(productionItems.id, live.id));
    expect(absorbed.deletedAt).not.toBeNull();
  });

  it("stops matching once an item is past the dated abandon horizon", async () => {
    const acct = await createTestAccount();
    const now = new Date();

    // Scheduled 15 days ago → well past the 7-day dated abandon horizon: never
    // matched again, even though a perfect candidate exists.
    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "instagram_reel",
      scheduledAt: new Date(now.getTime() - 15 * 24 * HOUR),
      expectedPublishAt: null,
      publishedAt: null,
      publishedDate: null,
    });
    await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "instagram_reel",
      publishedAt: now,
    });

    const summary = await runScheduleReconcile({
      client: stubClient(1, 95),
      onlyItemIds: [sched.id],
    });
    // The abandon bound filters it out of the query entirely.
    expect(summary.considered).toBe(0);
    expect(summary.autoMerged).toBe(0);

    const [row] = await db
      .select({ status: productionItems.status })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    expect(row.status).toBe("Scheduled");
  });

  it("lifts a flagged item out of Needs-attention into Suggestions when a borderline candidate appears", async () => {
    const acct = await createTestAccount();
    const now = new Date();

    const sched = await createTestProductionItem({
      accountId: acct.id,
      status: "Scheduled",
      postType: "instagram_reel",
      scheduledAt: new Date(now.getTime() - 30 * HOUR),
      expectedPublishAt: null,
      publishedAt: null,
      publishedDate: null,
      title: "AI agent cuts Google Ads cost-per-lead",
    });
    const cand = await createTestProductionItem({
      accountId: acct.id,
      status: "Published",
      postType: "instagram_reel",
      publishedAt: now,
      title: "AI agent cuts Google Ads cost-per-lead from $1,100 to $250",
    });

    const summary = await runScheduleReconcile({
      client: stubClient(1, 70), // borderline → suggestion, not auto-merge
      onlyItemIds: [sched.id],
    });
    expect(summary.suggested).toBe(1);

    const [row] = await db
      .select({
        na: productionItems.scheduleNeedsAttentionAt,
        status: productionItems.status,
      })
      .from(productionItems)
      .where(eq(productionItems.id, sched.id));
    // Flagged during this same pass, then cleared because we now have a
    // candidate awaiting a human — it belongs in Suggestions, not Needs-attention.
    expect(row.na).toBeNull();
    expect(row.status).toBe("Scheduled");

    const [suggestion] = await db
      .select({ status: scheduledMatchSuggestions.status })
      .from(scheduledMatchSuggestions)
      .where(
        and(
          eq(scheduledMatchSuggestions.scheduledItemId, sched.id),
          eq(scheduledMatchSuggestions.candidateItemId, cand.id),
        ),
      );
    expect(suggestion.status).toBe("pending");
  });
});
