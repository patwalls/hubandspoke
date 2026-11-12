import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, productionItems } from "@/lib/db/schema";
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

const winBellsFor = async (itemId: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.contentItemId, itemId), eq(notifications.kind, "win")));

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

    // wins-reach-makers M3: the editor of the fresh winner gets ONE bell
    // notification carrying the lift + note; the already-noted winner and the
    // usual post get none.
    expect(summary.notified).toBe(1);
    const bells = await winBellsFor(fresh.id);
    expect(bells).toHaveLength(1);
    expect(bells[0].userId).toBe(fresh.editorUserId);
    expect(bells[0].emailedAt).toBeNull();
    expect(bells[0].payload).toMatchObject({ kind: "win", lift: 8.4, note: "Opens on a dollar figure, not the founder." });
    expect(await winBellsFor(noted.id)).toHaveLength(0);
    expect(await winBellsFor(usual.id)).toHaveLength(0);

    // A rerun writes nothing and rings nothing.
    const again = await refreshWinNotes({
      brandSlugs: ["starter-story"],
      explain: async () => ({ ok: true, note: "x" }),
      getWinners: winnersOf(account.handle),
    });
    expect(again).toMatchObject({ written: 0, notified: 0 });
    expect(await winBellsFor(fresh.id)).toHaveLength(1);
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
