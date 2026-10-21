import { afterEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts, newsletterIssueHistory } from "@/lib/db/schema";
import { createTestFormat } from "@/test/factories";
import { loadUsage } from "./usage";

// Real format name (usage is grouped by schedule group = format name) under a
// throwaway brand; story keys are unique to this test so real data can't collide.
const K = "case:/stories/vitest-usage-story";
const HIST = "vitest-usage:";

afterEach(async () => {
  await db.delete(newsletterIssueHistory).where(like(newsletterIssueHistory.externalId, `${HIST}%`));
});

describe("loadUsage", () => {
  it("counts a story across Hub & Spoke drafts that went out and hand-built history, not discarded drafts", async () => {
    const fmt = await createTestFormat({ brand: "vitest-usage", name: "Sunday Breakfast" });
    const story = { kind: "case_study" as const, key: K, title: "t", url: "https://www.starterstory.com/stories/vitest-usage-story" };
    const base = { brand: "vitest-usage", formatId: fmt.id, windowStart: new Date(), windowEnd: new Date(), sections: [{ key: "coffee", markdown: "x", source: story }] };
    const [pushed] = await db.insert(newsletterDrafts).values({ ...base, status: "ready", sendDate: "2026-10-18", hubspotStatus: "created" }).returning({ id: newsletterDrafts.id });
    const [unsent] = await db.insert(newsletterDrafts).values({ ...base, status: "ready", sendDate: "2999-01-01" }).returning({ id: newsletterDrafts.id });
    await db.insert(newsletterIssueHistory).values({ brand: "starter-story", scheduleGroup: "sunday-breakfast", externalId: `${HIST}1`, origin: "hubspot", sentDate: "2026-09-14", sourceKeys: [K] });

    try {
      const usage = await loadUsage("sunday-breakfast");
      expect(usage.get(K)).toEqual({ count: 2, lastDate: "2026-10-18" }); // pushed draft + history; the unsent future draft doesn't count
      expect((await loadUsage("sunday-breakfast", { excludeDraftId: pushed.id })).get(K)).toEqual({ count: 1, lastDate: "2026-09-14" });
    } finally {
      await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, pushed.id));
      await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, unsent.id));
    }
  });
});
