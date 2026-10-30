import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestProductionItem } from "@/test/factories";
import { beehiivPostIdOf, syncRecentBeehiivNewsletterStats } from "./beehiiv-stats";

const itemOf = async (id: string) => (await db.select().from(productionItems).where(eq(productionItems.id, id)))[0];
const POST = (n: number) => `post_${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-${String(n).padStart(12, "0")}`;

describe("beehiiv newsletter stats", () => {
  it("writes unique opens as views, unique clicks and delivered on recent Futurepedia issues only", async () => {
    const id = POST(Date.now() % 1e8);
    const issue = await createTestProductionItem({ brand: "futurepedia", postType: "newsletter", platformContentId: id });
    const hubspotIssue = await createTestProductionItem({ brand: "starter-story", postType: "newsletter", platformContentId: `9${Date.now()}` });
    const old = await createTestProductionItem({ brand: "futurepedia", postType: "newsletter", platformContentId: POST(1), publishedAt: new Date("2025-01-05T13:00:00Z") });
    const asked: string[] = [];
    const n = await syncRecentBeehiivNewsletterStats(new Date(Date.now() - 86_400_000), async (postId) => {
      asked.push(postId);
      return { delivered: 190250, opens: 26766, clicks: 310, unsubscribes: 109 };
    });

    expect(asked).toContain(id);
    expect(asked).not.toContain(POST(1));
    expect(n).toBeGreaterThanOrEqual(1);
    const row = await itemOf(issue.id);
    expect([row.views, row.clicks, row.newsletterRecipients]).toEqual([26766, 310, 190250]);
    expect(row.lastPerformanceSyncAt).not.toBeNull();
    expect((await itemOf(hubspotIssue.id)).lastPerformanceSyncAt).toBeNull();
    expect((await itemOf(old.id)).lastPerformanceSyncAt).toBeNull();
  });

  it("a post with no stats yet keeps its numbers and notes why", async () => {
    const issue = await createTestProductionItem({ brand: "futurepedia", postType: "newsletter", platformContentId: POST((Date.now() + 7) % 1e8), views: 5 });
    await syncRecentBeehiivNewsletterStats(new Date(Date.now() - 86_400_000), async () => null);
    const row = await itemOf(issue.id);
    expect(row.views).toBe(5);
    expect(row.lastPerformanceSyncError).toMatch(/no stats/);
  });

  it("only Futurepedia newsletters whose id is a beehiiv post id are beehiiv issues", () => {
    expect(beehiivPostIdOf({ brand: "futurepedia", postType: "newsletter", platformContentId: POST(5) })).toBe(POST(5));
    expect(beehiivPostIdOf({ brand: "futurepedia", postType: "newsletter", platformContentId: "225249832610" })).toBeNull();
    expect(beehiivPostIdOf({ brand: "starter-story", postType: "newsletter", platformContentId: POST(5) })).toBeNull();
    expect(beehiivPostIdOf({ brand: "futurepedia", postType: "x", platformContentId: POST(5) })).toBeNull();
  });
});
