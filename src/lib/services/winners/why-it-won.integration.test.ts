import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestAccount, createTestProductionItem } from "@/test/factories";
import { getRecentWinners } from "@/lib/db/winners";
import { refreshWinNotes } from "./why-it-won";

/** The strip's winners, narrowed to one test account (the shared DB has
 *  other starter-story posts). */
const winnersOf = (handle: string) => async (brand: string) =>
  (await getRecentWinners(brand, { limit: 100 })).filter((w) => w.item.accountHandle === handle);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** One account with six usual TikToks (~1,000 views, 20–45 days old) and the
 *  given recent posts. */
async function accountWith(recent: { hook: string; views: number; winNote?: { note: string; lift: number; generatedAt: string; model: string } }[]) {
  const account = await createTestAccount({ platform: "tiktok" });
  for (let i = 0; i < 6; i++) {
    await createTestProductionItem({
      accountId: account.id,
      postType: "tiktok",
      views: 900 + i * 40,
      hook: `Meet the founder ${i}`,
      publishedAt: daysAgo(20 + i * 5),
    });
  }
  const items = [];
  for (const r of recent) {
    items.push(
      await createTestProductionItem({
        accountId: account.id,
        postType: "tiktok",
        views: r.views,
        hook: r.hook,
        publishedAt: daysAgo(2),
        winNote: r.winNote ?? null,
      }),
    );
  }
  return { account, items };
}

const noteOf = async (id: string) =>
  (await db.select({ n: productionItems.winNote }).from(productionItems).where(eq(productionItems.id, id)))[0].n;

describe("refreshWinNotes", () => {
  it("writes a note once per winner, comparing it with the account's usual posts", async () => {
    const kept = { note: "Already explained.", lift: 6, generatedAt: "2026-10-30T00:00:00Z", model: "m" };
    const { account, items } = await accountWith([
      { hook: "$40k a month from a spreadsheet", views: 8400 },
      { hook: "Old winner", views: 6000, winNote: kept },
      { hook: "Just a usual one", views: 1100 },
    ]);
    const [fresh, noted, usual] = items;

    const prompts: string[] = [];
    const summary = await refreshWinNotes({
      brandSlugs: ["starter-story"],
      explain: async (prompt) => {
        prompts.push(prompt);
        return { ok: true, note: "Opens on a dollar figure, not the founder." };
      },
      getWinners: winnersOf(account.handle),
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Hook: $40k a month from a spreadsheet");
    expect(prompts[0]).toContain("Hook: Meet the founder");
    expect(summary).toMatchObject({ written: 1, skipped: 1, failed: 0 });
    expect(await noteOf(fresh.id)).toMatchObject({ note: "Opens on a dollar figure, not the founder.", lift: 8.4 });
    expect(await noteOf(noted.id)).toEqual(kept);
    expect(await noteOf(usual.id)).toBeNull();
  });

  it("leaves the winner without a note when the model call fails, so the next run retries", async () => {
    const { account, items } = await accountWith([{ hook: "A big one", views: 9000 }]);
    const summary = await refreshWinNotes({
      brandSlugs: ["starter-story"],
      explain: async () => ({ ok: false, failure: "boom" }),
      getWinners: winnersOf(account.handle),
    });
    expect(summary.failed).toBe(1);
    expect(await noteOf(items[0].id)).toBeNull();
  });
});
